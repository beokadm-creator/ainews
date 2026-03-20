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
exports.requireAuth = requireAuth;
exports.requireAdmin = requireAdmin;
exports.getUserIdFromRequest = getUserIdFromRequest;
exports.isRequestUserAdmin = isRequestUserAdmin;
const admin = __importStar(require("firebase-admin"));
/**
 * Require authentication middleware
 * Validates Firebase ID token from Authorization header
 *
 * @param request - The HTTP request object
 * @param response - The HTTP response object
 * @returns Promise<boolean> - true if authenticated, false otherwise
 */
async function requireAuth(request, response) {
    try {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            response.status(401).json({
                success: false,
                error: 'Unauthorized: Missing or invalid Authorization header. Format: "Bearer <token>"'
            });
            return false;
        }
        const token = authHeader.split('Bearer ')[1];
        if (!token) {
            response.status(401).json({
                success: false,
                error: 'Unauthorized: No token provided'
            });
            return false;
        }
        // Verify the Firebase ID token
        const decodedToken = await admin.auth().verifyIdToken(token);
        if (!decodedToken || !decodedToken.uid) {
            response.status(401).json({
                success: false,
                error: 'Unauthorized: Invalid token'
            });
            return false;
        }
        // Attach the decoded token to the request for use in handlers
        request.user = decodedToken;
        return true;
    }
    catch (error) {
        console.error('Authentication error:', error);
        if (error.code === 'auth/id-token-expired') {
            response.status(401).json({
                success: false,
                error: 'Unauthorized: Token expired'
            });
        }
        else if (error.code === 'auth/id-token-revoked') {
            response.status(401).json({
                success: false,
                error: 'Unauthorized: Token revoked'
            });
        }
        else {
            response.status(401).json({
                success: false,
                error: `Unauthorized: ${error.message || 'Authentication failed'}`
            });
        }
        return false;
    }
}
/**
 * Require admin role middleware
 * Validates Firebase ID token and checks if user has admin role
 *
 * @param request - The HTTP request object
 * @param response - The HTTP response object
 * @returns Promise<boolean> - true if authenticated and is admin, false otherwise
 */
async function requireAdmin(request, response) {
    // First, check if user is authenticated
    const isAuthenticated = await requireAuth(request, response);
    if (!isAuthenticated) {
        return false;
    }
    try {
        const decodedToken = request.user;
        const uid = decodedToken.uid;
        // Check if user has admin role in Firestore
        const userDoc = await admin.firestore().collection('users').doc(uid).get();
        if (!userDoc.exists) {
            response.status(403).json({
                success: false,
                error: 'Forbidden: User not found in database'
            });
            return false;
        }
        const userData = userDoc.data();
        const role = userData?.role;
        if (!['superadmin', 'company_admin'].includes(role)) {
            response.status(403).json({
                success: false,
                error: 'Forbidden: Superadmin or company admin privileges required'
            });
            return false;
        }
        // Attach admin status to request
        request.user.isAdmin = true;
        return true;
    }
    catch (error) {
        console.error('Admin authorization error:', error);
        response.status(500).json({
            success: false,
            error: `Authorization check failed: ${error.message || 'Unknown error'}`
        });
        return false;
    }
}
/**
 * Get user ID from authenticated request
 * Helper function to extract uid from a request that has passed auth middleware
 *
 * @param request - The HTTP request object
 * @returns string | null - User UID if available, null otherwise
 */
function getUserIdFromRequest(request) {
    const user = request.user;
    return user?.uid || null;
}
/**
 * Check if request user is admin
 * Helper function to check admin status from a request that has passed admin middleware
 *
 * @param request - The HTTP request object
 * @returns boolean - True if user is admin, false otherwise
 */
function isRequestUserAdmin(request) {
    const user = request.user;
    return user?.isAdmin === true;
}
//# sourceMappingURL=authMiddleware.js.map