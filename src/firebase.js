import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth"; // NOVO: Importando a Autenticação

// MANTENHA AS SUAS CHAVES AQUI
const firebaseConfig = {
  apiKey: "AIzaSyAK7QORS6WBglMpKcBE30JsdWskUuVOhYQ",
  authDomain: "home-manager-app-4fd40.firebaseapp.com",
  projectId: "home-manager-app-4fd40",
  storageBucket: "home-manager-app-4fd40.firebasestorage.app",
  messagingSenderId: "646401649969",
  appId: "1:646401649969:web:1c9ea1ad0be79c5693d410",
  measurementId: "G-F9ZM79PSTZ"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app); // NOVO: Exportando a Autenticação

// service_jq21odj 
// template_xyz987
// Jsv9P7CFZlil6bO8L

// Upload Imagem Cloudinary
// dbjm8gl9q - Cloud Name
// homemanager - Upload Preset