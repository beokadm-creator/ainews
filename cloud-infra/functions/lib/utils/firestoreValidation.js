"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateFirestoreCollections = validateFirestoreCollections;
exports.ensureCollectionsExist = ensureCollectionsExist;
const admin = __importStar(require("firebase-admin"));
const REQUIRED_COLLECTIONS = [
    'companies',
    'articles',
    'outputs',
    'pipelineRuns',
    'sources',
    'users',
    // 신규 컬렉션
    'globalSources',
    'companySourceSubscriptions',
    'companySettings',
];
async function validateFirestoreCollections() {
    const db = admin.firestore();
    const missing = [];
    const existing = [];
    for (const collectionName of REQUIRED_COLLECTIONS) {
        try {
            const snapshot = await db.collection(collectionName).limit(1).get();
            existing.push(collectionName);
        }
        catch (error) {
            if (error.code === 5 || error.code === 'NOT_FOUND') {
                missing.push(collectionName);
            }
            else {
                console.warn(`Warning checking collection ${collectionName}:`, error.message);
                existing.push(collectionName);
            }
        }
    }
    return {
        valid: missing.length === 0,
        missing,
        existing
    };
}
async function ensureCollectionsExist() {
    const validation = await validateFirestoreCollections();
    if (!validation.valid) {
        console.warn('Missing Firestore collections:', validation.missing.join(', '));
        console.warn('Please create the following collections:', validation.missing.join(', '));
    }
    else {
        console.log('All required Firestore collections exist:', validation.existing.join(', '));
    }
}
//# sourceMappingURL=firestoreValidation.js.map