import * as logger from 'firebase-functions/logger';
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
    logger.error('Authentication error:', error);
    
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
