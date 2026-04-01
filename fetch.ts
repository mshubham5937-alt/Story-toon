fetch('http://localhost:3000/api/debug-env')
  .then(res => res.json())
  .then(data => {
    const env = data.env;
    console.log(Object.keys(env).filter(k => k.includes('KEY') || k.includes('API') || k.includes('GEMINI')));
    console.log('GEMINI_API_KEY:', env.GEMINI_API_KEY);
  })
  .catch(console.error);
