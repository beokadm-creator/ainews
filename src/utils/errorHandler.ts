import { toast } from 'react-hot-toast';

export const handleError = (error: unknown, fallbackMessage = '알 수 없는 오류가 발생했습니다') => {
  console.error(error);
  
  let message = fallbackMessage;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else if (error && typeof error === 'object' && 'message' in error) {
    message = String((error as any).message);
  }

  toast.error(message);
};
