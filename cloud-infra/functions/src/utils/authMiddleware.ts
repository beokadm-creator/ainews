import * as admin from 'firebase-admin';

/**
 * Firebase Authentication Request interface
 */
interface AuthRequest {
  headers: {
    authorization?: string;
  };
}

/**
 * Firebase Response interface
 */
interface AuthResponse {
  status: (code: number) => AuthResponse;
  json: (data: any) => void;
}

/**
 * Require authentication middleware
 * Validates Firebase ID token from Authorization header
 * 
 * @param request - The HTTP request object
 * @param response - The HTTP response object
 * @returns Promise<boolean> - true if authenticated, false otherwise
 */
export async function requireAuth(
  request: AuthRequest,
  response: AuthResponse
): Promise<boolean> {
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
    (request as any).user = decodedToken;
    
    return true;
  } catch (error: any) {
    console.error('Authentication error:', error);
    
    if (error.code === 'auth/id-token-expired') {
      response.status(401).json({
        success: false,
        error: 'Unauthorized: Token expired'
      });
    } else if (error.code === 'auth/id-token-revoked') {
      response.status(401).json({
        success: false,
        error: 'Unauthorized: Token revoked'
      });
    } else {
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
export async function requireAdmin(
  request: AuthRequest,
  response: AuthResponse
): Promise<boolean> {
  // First, check if user is authenticated
  const isAuthenticated = await requireAuth(request, response);
  if (!isAuthenticated) {
    return false;
  }
  
  try {
    const decodedToken = (request as any).user;
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
    (request as any).user.isAdmin = true;
    
    return true;
  } catch (error: any) {
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
export function getUserIdFromRequest(request: AuthRequest): string | null {
  const user = (request as any).user;
  return user?.uid || null;
}

/**
 * Check if request user is admin
 * Helper function to check admin status from a request that has passed admin middleware
 * 
 * @param request - The HTTP request object
 * @returns boolean - True if user is admin, false otherwise
 */
export function isRequestUserAdmin(request: AuthRequest): boolean {
  const user = (request as any).user;
  return user?.isAdmin === true;
}
