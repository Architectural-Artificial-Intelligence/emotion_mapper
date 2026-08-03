// progress.js — inline "done" checkmarks on the API key (gear icon), Plan,
// Photos and Heatmap sections. Other views call
// window.emotionMapperSetProgress(step, done) as each stage is fulfilled;
// badges reset whenever a project is (re)opened.

(function () {
  const checks = {
    apikey: document.getElementById('check-apikey'),
    plan: document.getElementById('check-plan'),
    images: document.getElementById('check-images'),
    heatmap: document.getElementById('check-heatmap'),
  };

  function setStep(key, done) {
    const el = checks[key];
    if (!el) return;
    el.classList.toggle('done', !!done);
  }
  window.emotionMapperSetProgress = setStep;

  document.addEventListener('emotionMapperProjectOpened', () => {
    Object.keys(checks).forEach((k) => setStep(k, false));
  });
})();
