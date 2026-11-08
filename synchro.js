  // ===== Synchronisation en ligne (Firebase) =====
  // Principe : l'appli marche toujours avec les données locales ; quand on est connecté,
  // chaque personne est un document Firestore, et seuls les champs modifiés sont envoyés.
  (function () {
    "use strict";
    const VERSION_SDK = "10.14.1";
    const firebaseConfig = {
      apiKey: "AIzaSyC9K1dlZD0tu5n7Pd-dQOyn1ITfGgKqz7w",
      authDomain: "arbre-genealogique-ec322.firebaseapp.com",
      projectId: "arbre-genealogique-ec322",
      storageBucket: "arbre-genealogique-ec322.firebasestorage.app",
      messagingSenderId: "687528477157",
      appId: "1:687528477157:web:b1f2d2ad7d1fde21b7ef0c"
    };

    // E-mail automatique à chaque demande d'accès (service gratuit Web3Forms) : colle ici ta clé.
    // Si elle reste vide, les demandes arrivent quand même dans l'appli (bouton « Accès à l'arbre »).
    const WEB3FORMS_CLE = "0adff0fe-72e0-46ce-a664-cea8a9c67911";
    const ADRESSE_APPLI = "https://jean2nnn.github.io/Arbre/";

    // E-mail automatique « ton accès est validé » (service gratuit EmailJS), à renseigner plus tard.
    // Tant que ces trois lignes sont vides, le bouton « Prévenir » ouvre ta messagerie avec le message prêt.
    const EMAILJS_SERVICE = "";
    const EMAILJS_MODELE = "";
    const EMAILJS_CLE = "";

    const CLE_INIT = "syncInit";
    const CLE_BASE = "baseSynchro";
    const CLE_COPIE = "sauvegardeAvantSynchro";

    const lire = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const ecrire = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
    const retirerCle = k => { try { localStorage.removeItem(k); } catch (e) {} };
    const copie = o => JSON.parse(JSON.stringify(o));
    const el = id => document.getElementById(id);

    const S = {
      A: null, Au: null, F: null, auth: null, db: null, user: null, unsub: null,
      pret: false, serveurVu: false, serveur: false, enAttente: false, enVol: 0,
      refus: false, ignore: false, chargement: false, erreurEcriture: false,
      unsubAcces: null, unsubAdmin: null, admin: false, adminOuvert: false, demandes: [], acces: [],
      etat: new Map()   // dernier état connu côté en ligne : id -> document
    };

    // B = « base » : pour chaque personne, empreinte de chaque champ à la dernière synchro.
    // Elle permet de savoir quels champs ont été modifiés ici depuis (fusion à trois voies).
    let B = {};
    try { B = JSON.parse(lire(CLE_BASE) || "{}") || {}; } catch (e) { B = {}; }

    function h(v) {
      const s = v === undefined ? "u" : JSON.stringify(v);
      let x = 2166136261;
      for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
      return (x >>> 0).toString(36) + "." + s.length.toString(36);
    }
    const H_ABSENT = h(undefined);
    function baseDe(o) { const r = {}; for (const k of Object.keys(o)) r[k] = h(o[k]); return r; }
    function sauverBase() { ecrire(CLE_BASE, JSON.stringify(B)); }
    function sauverLocal() { ecrire("personnes", JSON.stringify(personnes)); }

    function egal(a, b) {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every(k => k in b && JSON.stringify(a[k]) === JSON.stringify(b[k]));
    }

    function normaliser(id, o) {
      const d = copie(o);
      if (d.id === undefined) d.id = /^\d+$/.test(id) ? Number(id) : id;
      if (!Array.isArray(d.conjoints)) d.conjoints = [];
      return d;
    }

    // met à jour la personne locale « sur place » (les formulaires gardent leur référence)
    function appliquerDoc(id, o) {
      const d = normaliser(id, o);
      S.etat.set(id, copie(d));
      B[id] = baseDe(d);
      const p = personnes.find(x => String(x.id) === id);
      if (!p) { personnes.push(copie(d)); return true; }
      if (egal(p, d)) return false;
      for (const k of Object.keys(p)) if (!(k in d)) delete p[k];
      for (const k of Object.keys(d)) p[k] = d[k];
      return true;
    }

    function retirerLocal(id) {
      const i = personnes.findIndex(p => String(p.id) === id);
      if (i >= 0) personnes.splice(i, 1);
      S.etat.delete(id);
      delete B[id];
      return i >= 0;
    }

    // ---------- première synchro sur cet appareil ----------
    function premierSync(docs) {
      ecrire(CLE_COPIE, JSON.stringify(personnes));   // filet de sécurité
      const absentes = personnes.filter(p => !docs.has(String(p.id)));
      let envoyer = true;
      if (docs.size > 0 && absentes.length > 0) {
        envoyer = confirm("Cet appareil contient " + absentes.length + " personne(s) absente(s) de l'arbre en ligne partagé.\n\n" +
          "OK : les ajouter à l'arbre commun.\nAnnuler : ne pas les ajouter (une copie reste gardée sur cet appareil).");
      }
      B = {};
      for (const [id, o] of docs) appliquerDoc(id, o);   // l'arbre en ligne l'emporte
      if (!envoyer) for (const p of absentes) { const i = personnes.indexOf(p); if (i >= 0) personnes.splice(i, 1); }
    }

    // ---------- démarrages suivants : fusion à trois voies ----------
    function fusionner(docs, serveur) {
      const locaux = new Map(personnes.map(p => [String(p.id), p]));
      for (const [id, o] of docs) {
        const p = locaux.get(id);
        const d = normaliser(id, o);
        if (!p) {
          if (B[id]) { S.etat.set(id, copie(d)); continue; }   // supprimée ici, suppression à envoyer
          appliquerDoc(id, o);
          continue;
        }
        if (!B[id]) { appliquerDoc(id, o); continue; }          // pas de base : l'arbre en ligne l'emporte
        const b = B[id];
        const nouvelleBase = {};
        const cles = new Set([...Object.keys(p), ...Object.keys(d), ...Object.keys(b)]);
        for (const k of cles) {
          const hb = b[k] !== undefined ? b[k] : H_ABSENT;
          const modifLocale = h(p[k]) !== hb;
          if (modifLocale) {
            nouvelleBase[k] = hb;                               // on garde la valeur d'ici, elle sera envoyée
          } else {
            if (k in d) p[k] = d[k]; else delete p[k];
            nouvelleBase[k] = h(d[k]);
          }
        }
        for (const k of Object.keys(nouvelleBase)) if (nouvelleBase[k] === H_ABSENT) delete nouvelleBase[k];
        B[id] = nouvelleBase;
        S.etat.set(id, copie(d));
      }
      if (serveur) verifierAbsences(docs);
    }

    // une personne synchronisée autrefois mais absente de l'arbre en ligne : supprimée par quelqu'un d'autre
    function verifierAbsences(docs) {
      let change = false;
      for (const p of personnes.slice()) {
        const id = String(p.id);
        if (!docs.has(id) && B[id]) change = retirerLocal(id) || change;
      }
      return change;
    }

    // ---------- envoi des modifications locales ----------
    function pousser() {
      if (!S.pret || !S.user) return;
      const ops = [];
      const vus = new Set();
      for (const p of personnes) {
        const id = String(p.id);
        vus.add(id);
        const doc = copie(p);
        const ancien = S.etat.get(id);
        if (!ancien) {
          if (B[id] && !S.serveurVu) continue;                  // absence pas encore confirmée par le serveur
          ops.push({ t: "set", id: id, doc: doc, champs: Object.keys(doc) });
        } else {
          const cles = new Set([...Object.keys(doc), ...Object.keys(ancien)]);
          const champs = [...cles].filter(k => JSON.stringify(doc[k]) !== JSON.stringify(ancien[k]));
          if (champs.length) ops.push({ t: "set", id: id, doc: doc, champs: champs });
        }
      }
      for (const id of S.etat.keys()) if (!vus.has(id)) ops.push({ t: "del", id: id });
      if (!ops.length) return;

      for (const op of ops) {
        if (op.t === "set") { S.etat.set(op.id, copie(op.doc)); B[op.id] = baseDe(op.doc); }
        else { S.etat.delete(op.id); delete B[op.id]; }
      }
      sauverBase();
      envoyer(ops);
    }

    function envoyer(ops) {
      const F = S.F;
      for (let i = 0; i < ops.length; i += 400) {
        const b = F.writeBatch(S.db);
        for (const op of ops.slice(i, i + 400)) {
          const ref = F.doc(S.db, "personnes", op.id);
          if (op.t === "del") { b.delete(ref); continue; }
          const data = {};
          for (const k of op.champs) data[k] = (k in op.doc) ? op.doc[k] : F.deleteField();
          b.set(ref, data, { mergeFields: op.champs });
        }
        S.enVol++;
        b.commit()
          .then(() => { S.enVol--; S.erreurEcriture = false; majStatut(); })
          .catch(err => { S.enVol--; console.error(err); S.erreurEcriture = true; majStatut(); });
      }
      majStatut();
    }

    // ---------- réception ----------
    function traiterSnapshot(snap) {
      const serveur = !snap.metadata.fromCache;
      S.serveur = serveur;
      S.enAttente = snap.metadata.hasPendingWrites;
      const docs = new Map();
      snap.forEach(d => {
        const o = d.data();
        if (o && o.prenom !== undefined) docs.set(String(d.id), o);   // ignore les fiches incomplètes
      });

      if (!S.pret) {
        const premier = lire(CLE_INIT) !== "1";
        if (premier && !serveur) { majStatut(); return; }    // on attend une vraie réponse du serveur
        if (premier) premierSync(docs); else fusionner(docs, serveur);
        S.serveurVu = serveur;
        S.pret = true;
        ecrire(CLE_INIT, "1");
        sauverLocal();
        sauverBase();
        pousser();
        rafraichir();
      } else {
        let change = false;
        if (serveur && !S.serveurVu) {
          S.serveurVu = true;
          change = verifierAbsences(docs);
          pousser();
        }
        snap.docChanges().forEach(ch => {
          const id = String(ch.doc.id);
          if (ch.type === "removed") {
            change = retirerLocal(id) || change;
            return;
          }
          const o = ch.doc.data();
          if (!o || o.prenom === undefined) return;
          const connu = S.etat.get(id);
          if (connu && egal(connu, normaliser(id, o))) return;   // simple écho de nos propres envois
          change = appliquerDoc(id, o) || change;
        });
        if (change) { sauverLocal(); sauverBase(); rafraichir(); }
      }
      majStatut();
    }

    function pageVisible() {
      for (const p of PAGES) {
        const e = el("page-" + p);
        if (e && getComputedStyle(e).display !== "none") return p;
      }
      return "accueil";
    }

    function rafraichir() {
      try {
        if ((personneCentrale && !personnes.includes(personneCentrale)) ||
            (racineArbre && !personnes.includes(racineArbre))) reinitialiserArbre();
        const page = pageVisible();
        if (page === "accueil" || page === "arbre") {
          afficher();
        } else {
          const n = personnes.length;   // on ne touche pas aux formulaires en cours de saisie
          el("compteur").textContent = n === 0 ? "Aucune personne enregistrée" :
            "👥 " + n + " personne" + (n > 1 ? "s" : "") + " enregistrée" + (n > 1 ? "s" : "");
        }
      } catch (e) { console.error(e); }
    }

    // ---------- écoute de l'arbre en ligne ----------
    function demarrer() {
      if (S.unsub) return;
      S.refus = false; S.pret = false; S.serveurVu = false;
      S.unsub = S.F.onSnapshot(S.F.collection(S.db, "personnes"), { includeMetadataChanges: true },
        snap => { try { traiterSnapshot(snap); } catch (e) { console.error(e); } },
        err => {
          console.error(err);
          if (S.unsub) { try { S.unsub(); } catch (e) {} }
          S.unsub = null;
          if (err && err.code === "permission-denied") { S.refus = true; proposerAcces(); }
          majStatut();
        });
    }

    function arreter() {
      if (S.unsub) { try { S.unsub(); } catch (e) {} }
      S.unsub = null; S.pret = false; S.serveurVu = false; S.enAttente = false; S.refus = false;
      S.etat = new Map();
      arreterAcces();
      arretAdmin();
    }

    // ---------- statut sur l'accueil ----------
    function majStatut() {
      const z = el("statut-sync");
      if (!z) return;
      let t;
      if (!S.F) t = navigator.onLine ? "☁️ Synchronisation : chargement…" : "📴 Hors ligne — synchronisation en pause";
      else if (!S.user) t = "☁️ Non connecté — touche ici pour te connecter";
      else if (S.refus) t = "⛔ Pas encore d'accès à l'arbre pour " + S.user.email + " — touche ici pour le demander";
      else if (!S.user.emailVerified) t = "✉️ Adresse e-mail à vérifier — touche ici";
      else if (!S.pret) t = "⏳ Connexion à l'arbre en ligne…";
      else if (S.erreurEcriture) t = "⚠️ Une modification n'a pas pu être envoyée";
      else if (!S.serveur) t = "📴 Hors ligne — tes modifications seront envoyées au retour du réseau";
      else if (S.enAttente || S.enVol > 0) t = "⏳ Envoi en cours…";
      else t = "✅ Synchronisé avec l'arbre en ligne";
      z.textContent = t;
      const b = el("btn-deconnexion");
      if (b) b.style.display = S.user ? "inline-block" : "none";
    }

    // ---------- écran de connexion ----------
    function message(texte, bon) {
      const m = el("cx-message");
      m.textContent = texte || "";
      m.style.color = bon ? "#1b5e20" : "#b71c1c";
    }

    function montrerEcran(mode) {
      el("ecran-connexion").style.display = "flex";
      el("cx-bloc-connexion").style.display = mode === "connexion" ? "block" : "none";
      el("cx-bloc-verif").style.display = mode === "verification" ? "block" : "none";
      el("cx-bloc-acces").style.display = mode === "acces" ? "block" : "none";
      if (mode === "verification") el("cx-verif-email").textContent = S.user ? S.user.email : "";
      message("");
      if (mode === "acces") {
        el("cx-acces-email").textContent = S.user ? S.user.email : "";
        verifierDemande();
      }
    }
    function masquerEcran() { el("ecran-connexion").style.display = "none"; }

    function texteErreur(e) {
      const c = e && e.code ? e.code : "";
      if (c === "auth/invalid-credential" || c === "auth/wrong-password" || c === "auth/user-not-found") return "E-mail ou mot de passe incorrect.";
      if (c === "auth/email-already-in-use") return "Un compte existe déjà avec cette adresse : touche « Se connecter ».";
      if (c === "auth/weak-password") return "Mot de passe trop court (6 caractères minimum).";
      if (c === "auth/invalid-email") return "Adresse e-mail non valide.";
      if (c === "auth/network-request-failed") return "Pas de connexion Internet.";
      if (c === "auth/too-many-requests") return "Trop d'essais : patiente quelques minutes.";
      return "Erreur : " + (c || (e && e.message) || "inconnue");
    }

    function identifiants() {
      const email = el("cx-email").value.trim().toLowerCase();
      const mdp = el("cx-mdp").value;
      return { email: email, mdp: mdp };
    }

    async function seConnecter() {
      const { email, mdp } = identifiants();
      if (!email || !mdp) { message("Renseigne ton e-mail et ton mot de passe."); return; }
      message("Connexion…", true);
      try { await S.Au.signInWithEmailAndPassword(S.auth, email, mdp); message(""); }
      catch (e) { message(texteErreur(e)); }
    }

    async function creerCompte() {
      const { email, mdp } = identifiants();
      if (!email || !mdp) { message("Renseigne ton e-mail et choisis un mot de passe."); return; }
      if (mdp.length < 6) { message("Mot de passe trop court (6 caractères minimum)."); return; }
      message("Création du compte…", true);
      try {
        const cred = await S.Au.createUserWithEmailAndPassword(S.auth, email, mdp);
        try { await S.Au.sendEmailVerification(cred.user); } catch (e) {}
      } catch (e) { message(texteErreur(e)); }
    }

    async function motDePasseOublie() {
      const { email } = identifiants();
      if (!email) { message("Écris d'abord ton adresse e-mail ci-dessus."); return; }
      try { await S.Au.sendPasswordResetEmail(S.auth, email); message("Si un compte existe, un e-mail de réinitialisation vient d'être envoyé.", true); }
      catch (e) { message(texteErreur(e)); }
    }

    async function verifie() {
      if (!S.user) return;
      try {
        await S.user.reload();
        await S.user.getIdToken(true);
        if (S.user.emailVerified) { utilisateurChange(S.user); }
        else message("Adresse pas encore vérifiée : ouvre le lien reçu par e-mail, puis réessaie.");
      } catch (e) { message(texteErreur(e)); }
    }

    async function renvoyer() {
      if (!S.user) return;
      try { await S.Au.sendEmailVerification(S.user); message("E-mail renvoyé.", true); }
      catch (e) { message(texteErreur(e)); }
    }

    function ouvrirConnexion() {
      S.ignore = false;
      if (!S.F) {
        if (!navigator.onLine) { alert("Pas de connexion Internet : impossible de se connecter pour l'instant."); return; }
        initFirebase();
        return;
      }
      if (!S.user) montrerEcran("connexion");
      else if (!S.user.emailVerified) montrerEcran("verification");
      else if (S.refus) montrerEcran("acces");
    }

    async function deconnecter() {
      if (!S.F) return;
      const sur = S.pret && S.serveur && !S.enAttente && S.enVol === 0;
      if (!confirm("Te déconnecter ?")) return;
      // on n'efface la copie locale que si tout est bien enregistré en ligne
      let effacer = false;
      if (sur) {
        effacer = confirm("Effacer aussi l'arbre enregistré sur cet appareil ?\n\nOK = effacer (il reste en ligne et reviendra à ta prochaine connexion).\nAnnuler = le garder ici.");
      } else {
        alert("Des modifications ne sont peut-être pas encore envoyées en ligne : l'arbre de cet appareil est conservé.");
      }
      arreter();
      try { await S.Au.signOut(S.auth); } catch (e) {}
      if (effacer) {
        retirerCle("personnes"); retirerCle(CLE_BASE); retirerCle(CLE_INIT); retirerCle(CLE_COPIE);
        try { await S.F.terminate(S.db); await S.F.clearIndexedDbPersistence(S.db); } catch (e) {}
        location.reload();
      }
    }

    function utilisateurChange(user) {
      S.user = user;
      if (!user) {
        arreter();
        if (!S.ignore) montrerEcran("connexion");
      } else if (!user.emailVerified) {
        arreter();
        montrerEcran("verification");
      } else {
        masquerEcran();
        demarrer();
        demarrerAdmin();
      }
      majStatut();
    }

    async function initFirebase() {
      if (S.F || S.chargement) return;
      S.chargement = true;
      try {
        const base = "https://www.gstatic.com/firebasejs/" + VERSION_SDK + "/";
        const [A, Au, F] = await Promise.all([
          import(base + "firebase-app.js"),
          import(base + "firebase-auth.js"),
          import(base + "firebase-firestore.js")
        ]);
        const app = A.initializeApp(firebaseConfig);
        S.auth = Au.getAuth(app);
        S.auth.languageCode = "fr";
        try {
          S.db = F.initializeFirestore(app, {
            localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() })
          });
        } catch (e) { S.db = F.getFirestore(app); }
        S.A = A; S.Au = Au; S.F = F;
        Au.onAuthStateChanged(S.auth, utilisateurChange);
      } catch (e) {
        console.warn("Firebase indisponible pour l'instant", e);
        S.F = null;
      }
      S.chargement = false;
      majStatut();
    }

    // ---------- demandes d'accès (côté demandeur) ----------
    const emailMin = () => S.user.email.toLowerCase();
    const delaiPrive = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code: "delai" }), ms))]);

    function arreterAcces() {
      if (S.unsubAcces) { try { S.unsubAcces(); } catch (e) {} }
      S.unsubAcces = null;
    }

    // dès que le propriétaire autorise l'adresse, l'écran se ferme et la synchro démarre toute seule
    function surveillerAcces() {
      if (S.unsubAcces || !S.user) return;
      const F = S.F;
      S.unsubAcces = F.onSnapshot(F.doc(S.db, "acces", emailMin()), snap => {
        if (!snap.exists()) return;
        arreterAcces();
        S.refus = false;
        masquerEcran();
        demarrer();
        majStatut();
      }, err => console.warn(err));
    }

    function proposerAcces() {
      surveillerAcces();
      if (!S.ignore) montrerEcran("acces");
    }

    function cacherDemande(oui) {
      el("cx-demander").style.display = oui ? "none" : "block";
      el("cx-nom").style.display = oui ? "none" : "block";
    }

    async function verifierDemande() {
      cacherDemande(true);
      try {
        const s = await delaiPrive(S.F.getDoc(S.F.doc(S.db, "demandes", emailMin())), 6000);
        if (s.exists()) {
          const d = new Date((s.data() || {}).date);
          const quand = isNaN(d) ? "" : " le " + d.toLocaleDateString("fr-FR");
          message("Demande envoyée" + quand + ", en attente de validation. Cet écran se mettra à jour tout seul.", true);
          return;
        }
      } catch (e) { console.warn(e); }
      cacherDemande(false);
    }

    function prevenirParMail(nom, email) {
      if (!WEB3FORMS_CLE) return;
      fetch("https://api.web3forms.com/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          access_key: WEB3FORMS_CLE,
          subject: "Demande d'accès à l'arbre généalogique",
          from_name: "Arbre généalogique",
          name: nom,
          email: email,
          message: nom + " (" + email + ") demande l'accès à l'arbre.\n\nOuvre l'appli pour l'autoriser ou la refuser : " + ADRESSE_APPLI
        })
      }).catch(e => console.warn("Prévenir par e-mail : échec", e));
    }

    async function demanderAcces() {
      const nom = el("cx-nom").value.trim();
      if (!nom) { message("Indique ton prénom et ton nom pour qu'on te reconnaisse."); return; }
      if (!navigator.onLine) { message("Pas de connexion Internet."); return; }
      const email = emailMin();
      message("Envoi de la demande…", true);
      try {
        await delaiPrive(S.F.setDoc(S.F.doc(S.db, "demandes", email), { email: email, nom: nom, date: new Date().toISOString() }), 10000);
      } catch (e) {
        message("La demande n'a pas pu être envoyée (" + ((e && e.code) || "erreur") + "). Réessaie.");
        return;
      }
      prevenirParMail(nom, email);
      cacherDemande(true);
      message("Demande envoyée ✔ Tu auras accès dès qu'elle sera validée : cet écran se mettra à jour tout seul.", true);
    }

    // ---------- demandes d'accès (côté propriétaire) ----------
    // Le propriétaire est la seule adresse autorisée par les règles à lire les demandes :
    // si la lecture réussit, on affiche le bouton « Accès à l'arbre ».
    function arretAdmin() {
      if (S.unsubAdmin) { try { S.unsubAdmin(); } catch (e) {} }
      S.unsubAdmin = null; S.admin = false; S.demandes = []; S.acces = [];
      majBoutonAdmin();
    }

    function demarrerAdmin() {
      if (S.unsubAdmin || !S.user || !S.user.emailVerified) return;
      const F = S.F;
      let u2 = null;
      const u1 = F.onSnapshot(F.collection(S.db, "demandes"), snap => {
        if (!S.admin) {
          S.admin = true;
          u2 = F.onSnapshot(F.collection(S.db, "acces"), s => {
            S.acces = s.docs.map(d => Object.assign({ id: d.id }, d.data()));
            rendreAdmin();
          }, e => console.warn(e));
        }
        S.demandes = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        majBoutonAdmin();
        rendreAdmin();
      }, () => { S.unsubAdmin = null; });   // pas le propriétaire : rien à afficher
      S.unsubAdmin = () => { u1(); if (u2) u2(); };
    }

    function majBoutonAdmin() {
      const b = el("btn-demandes");
      if (!b) return;
      b.style.display = S.admin ? "inline-block" : "none";
      const n = S.demandes.length;
      b.textContent = "🔔 Accès à l'arbre" + (n ? " (" + n + " demande" + (n > 1 ? "s" : "") + ")" : "");
      b.style.background = n ? "#d81b60" : "";
    }

    function ligneAdmin(titre, sous, boutons) {
      const d = document.createElement("div");
      d.className = "adm-ligne";
      const t = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = titre;
      const s = document.createElement("div");
      s.textContent = sous;
      s.style.fontSize = "0.85em";
      s.style.color = "#555";
      t.appendChild(b); t.appendChild(s);
      d.appendChild(t);
      for (const [libelle, action, classe] of boutons) {
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = libelle;
        if (classe) x.className = classe;
        x.onclick = action;
        d.appendChild(x);
      }
      return d;
    }

    function rendreAdmin() {
      if (!S.adminOuvert) return;
      const zd = el("adm-demandes");
      zd.textContent = S.demandes.length ? "" : "Aucune demande en attente.";
      for (const d of S.demandes) {
        zd.appendChild(ligneAdmin(d.nom || d.id, d.id, [["Autoriser", () => autoriser(d)], ["Refuser", () => refuser(d), "secondaire"]]));
      }
      const za = el("adm-acces");
      za.textContent = S.acces.length ? "" : "Personne d'autre pour l'instant.";
      for (const a of S.acces) {
        za.appendChild(ligneAdmin(a.nom || a.id, a.id, [["Prévenir", () => prevenirPersonne(a)], ["Retirer l'accès", () => retirerAcces(a), "secondaire"]]));
      }
    }

    function ouvrirAdmin() {
      if (!S.admin) return;
      S.adminOuvert = true;
      el("ecran-admin").style.display = "flex";
      rendreAdmin();
    }
    function fermerAdmin() { S.adminOuvert = false; el("ecran-admin").style.display = "none"; }

    function textePrevenir(nom) {
      return {
        sujet: "Ton accès à l'arbre de la famille est validé",
        message: "Bonjour" + (nom ? " " + nom : "") + ",\n\nTon accès à l'arbre généalogique de la famille est validé. " +
          "Ouvre l'application ou ce lien : " + ADRESSE_APPLI + "\nTon arbre se chargera automatiquement.\n\nJean"
      };
    }

    // Envoie le message d'accès validé : direct si EmailJS est configuré, sinon brouillon dans la messagerie
    async function prevenirPersonne(p) {
      const t = textePrevenir(p.nom);
      if (EMAILJS_SERVICE && EMAILJS_MODELE && EMAILJS_CLE) {
        try {
          const r = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              service_id: EMAILJS_SERVICE, template_id: EMAILJS_MODELE, user_id: EMAILJS_CLE,
              template_params: { to_email: p.id, to_name: p.nom || "", sujet: t.sujet, message: t.message, lien: ADRESSE_APPLI }
            })
          });
          if (r.ok) { alert("✉️ Message envoyé à " + p.id); return; }
          console.warn("EmailJS", r.status);
        } catch (e) { console.warn("EmailJS", e); }
        alert("L'envoi automatique a échoué : ta messagerie va s'ouvrir avec le message prêt à envoyer.");
      }
      const a = document.createElement("a");
      a.href = "mailto:" + p.id + "?subject=" + encodeURIComponent(t.sujet) + "&body=" + encodeURIComponent(t.message);
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    async function autoriser(d) {
      try {
        await S.F.setDoc(S.F.doc(S.db, "acces", d.id), { email: d.id, nom: d.nom || "", date: new Date().toISOString() });
        await S.F.deleteDoc(S.F.doc(S.db, "demandes", d.id));
      } catch (e) { alert("Erreur : " + ((e && e.code) || "inconnue")); return; }
      if (confirm("Accès autorisé ✔\n\nPrévenir " + (d.nom || d.id) + " par e-mail maintenant ?")) prevenirPersonne({ id: d.id, nom: d.nom });
    }
    async function refuser(d) {
      if (!confirm("Refuser la demande de " + (d.nom || d.id) + " ?")) return;
      try { await S.F.deleteDoc(S.F.doc(S.db, "demandes", d.id)); }
      catch (e) { alert("Erreur : " + ((e && e.code) || "inconnue")); }
    }
    async function retirerAcces(a) {
      if (!confirm("Retirer l'accès de " + (a.nom || a.id) + " ?\n\nSa copie de l'arbre reste sur son appareil, mais elle ne pourra plus se synchroniser.")) return;
      try { await S.F.deleteDoc(S.F.doc(S.db, "acces", a.id)); }
      catch (e) { alert("Erreur : " + ((e && e.code) || "inconnue")); }
    }

    // ---------- branchements ----------
    el("cx-demander").onclick = demanderAcces;
    el("cx-acces-autre").onclick = async () => { try { await S.Au.signOut(S.auth); } catch (e) {} };
    el("cx-acces-fermer").onclick = () => { S.ignore = true; masquerEcran(); };
    el("adm-fermer").onclick = fermerAdmin;
    el("cx-connecter").onclick = seConnecter;
    el("cx-creer").onclick = creerCompte;
    el("cx-oublie").onclick = motDePasseOublie;
    el("cx-plus-tard").onclick = () => { S.ignore = true; masquerEcran(); };
    el("cx-verifie").onclick = verifie;
    el("cx-renvoyer").onclick = renvoyer;
    el("cx-autre").onclick = async () => { try { await S.Au.signOut(S.auth); } catch (e) {} };
    el("cx-mdp").addEventListener("keydown", e => { if (e.key === "Enter") seConnecter(); });
    window.addEventListener("online", () => { if (!S.F) initFirebase(); majStatut(); });
    window.addEventListener("offline", majStatut);

    window.synchro = {
      apresSauvegarde: pousser,
      actif: () => !!(S.pret && S.user),
      ouvrirConnexion: ouvrirConnexion,
      ouvrirAdmin: ouvrirAdmin,
      deconnecter: deconnecter
    };

    majStatut();
    initFirebase();
  })();
