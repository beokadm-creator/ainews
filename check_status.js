const admin = require('firebase-admin');

// Firebase CLI를 통한 인증 시도
const projectId = 'eumnews-9a99c';

(async () => {
  try {
    const { spawn } = require('child_process');
    
    // firebase emulator로 데이터 조회 (또는 다른 방법)
    const result = await new Promise((resolve, reject) => {
      const proc = spawn('firebase', ['emulators:exec', '--project', projectId, 'echo "test"'], {
        cwd: __dirname
      });
      
      proc.on('close', (code) => {
        resolve(code);
      });
    });
    
    console.log('Firebase CLI 테스트:', result);
  } catch (error) {
    console.error('Error:', error.message);
  }
})();
