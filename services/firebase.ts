import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import * as firestore from 'firebase/firestore';

// Helper to safely access environment variables in various environments
const getEnv = (key: string) => {
  try {
    // Fix for "Property 'env' does not exist on type 'ImportMeta'" and missing vite/client types
    const meta = import.meta as any;
    if (typeof meta !== 'undefined' && meta.env) {
      return meta.env[key];
    }
  } catch (e) {
    console.warn('Error accessing environment variable:', key);
  }
  return undefined;
};

// Firebase config: reads from VITE_ env vars at build time (set in Vercel Project Settings).
// Falls back to hardcoded values if env vars are not available.
// Note: Firebase web API keys are public client-side keys - hardcoding is the standard practice.
const FALLBACK_CONFIG = {
  apiKey: "AIzaSyAaoOj1paBT1ULmqjwlHJQ-c0ZJ4zQMO6k",
  authDomain: "travel-allowance-system.firebaseapp.com",
  projectId: "travel-allowance-system",
  storageBucket: "travel-allowance-system.firebasestorage.app",
  messagingSenderId: "26796165933",
  appId: "1:26796165933:web:040120e1b8fb670cd9e1a4"
};

const firebaseConfig = {
  apiKey: getEnv('VITE_FIREBASE_API_KEY') || FALLBACK_CONFIG.apiKey,
  authDomain: getEnv('VITE_FIREBASE_AUTH_DOMAIN') || FALLBACK_CONFIG.authDomain,
  projectId: getEnv('VITE_FIREBASE_PROJECT_ID') || FALLBACK_CONFIG.projectId,
  storageBucket: getEnv('VITE_FIREBASE_STORAGE_BUCKET') || FALLBACK_CONFIG.storageBucket,
  messagingSenderId: getEnv('VITE_FIREBASE_MESSAGING_SENDER_ID') || FALLBACK_CONFIG.messagingSenderId,
  appId: getEnv('VITE_FIREBASE_APP_ID') || FALLBACK_CONFIG.appId
};

// Check if config is valid (checks for undefined, null, empty string, or "undefined" string)
const isConfigValid =
  firebaseConfig.apiKey &&
  firebaseConfig.apiKey !== 'undefined' &&
  firebaseConfig.projectId &&
  firebaseConfig.projectId !== 'undefined';

// Export demo mode flag
export const isDemoMode = !isConfigValid;

if (isDemoMode) {
  console.warn("⚠️ Firebase config missing. Running in DEMO MODE (Local Storage).");
}

// Initialize Firebase with real config or dummy config to prevent crash
// If config is missing, we initialize with dummies but App.tsx will skip using them based on isDemoMode
const app = initializeApp(isConfigValid ? firebaseConfig : {
  apiKey: "dummy-key",
  authDomain: "dummy.firebaseapp.com",
  projectId: "dummy-project"
});

export const auth = getAuth(app);

// Use type casting to avoid "no exported member" errors with some TS/Firebase versions
const { getFirestore } = firestore as any;
export const db = getFirestore(app);

// Use a specific app ID for Firestore collection segregation if needed
export const APP_ID = getEnv('VITE_APP_IDENTIFIER') || 'default-app';