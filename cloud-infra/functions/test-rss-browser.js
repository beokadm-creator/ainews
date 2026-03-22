// Firebase 콘솔 또는 앱 어디에서나 실행 가능
// 복사해서 브라우저 개발자 도구(F12) 콘솔에 붙여넣고 엔터

const triggerRssCollection = firebase.functions().httpsCallable('triggerRssCollection');

triggerRssCollection({})
  .then(result => {
    console.log('✅ RSS 수집 시작!');
    console.log('응답:', result.data);
  })
  .catch(error => {
    console.error('❌ 에러:', error.message);
  });
