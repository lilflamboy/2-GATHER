// frontend/src/firebase.js
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// Frontend Firebase bootstrapping stays tiny: this app currently relies on
// Firebase Auth and Google sign-in, while the backend verifies tokens.
const firebaseConfig = {
  apiKey: "AIzaSyAHTsY71O19m50CSEqGyAnFl_qcOn1iqcs",
  authDomain: "lumiere-21a55.firebaseapp.com",
  projectId: "lumiere-21a55",
  storageBucket: "lumiere-21a55.firebasestorage.app",
  messagingSenderId: "479692683498",
  appId: "1:479692683498:web:c2ee8dcad51fdea8bbbf93",
  measurementId: "G-CLW0H1NZFD"
};

const app = initializeApp(firebaseConfig);

// Export singleton auth/provider instances so every screen shares the same app.
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
