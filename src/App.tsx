import { useState } from 'react';
import { Sparkles, Play, Loader2, Film, RefreshCw, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { StoryInput } from './components/StoryInput';
import { ProgressIndicator } from './components/ProgressIndicator';
import { VideoPlayer } from './components/VideoPlayer';
import { GoogleGenAI, Type, GenerateContentParameters } from '@google/genai';

interface SceneData {
  prompt: string;
  image: string;
  isRegenerating?: boolean;
}

const generateWithRetry = async (aiClient: GoogleGenAI, config: GenerateContentParameters, retries = 8, backoffMs = 32000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await aiClient.models.generateContent(config);
    } catch (error: any) {
      const errorStr = JSON.stringify(error).toLowerCase();
      const isRateLimit = 
        error.status === 429 || 
        error.code === 429 ||
        errorStr.includes('429') || 
        errorStr.includes('quota') || 
        errorStr.includes('resource_exhausted');
        
      const isTransient = 
        error.status === 500 || 
        error.status === 503 || 
        errorStr.includes('500') || 
        errorStr.includes('503') || 
        errorStr.includes('xhr error') || 
        errorStr.includes('rpc failed');
      
      if ((isRateLimit || isTransient) && i < retries - 1) {
        const waitTime = isRateLimit ? backoffMs : 5000;
        console.warn(`API error (${isRateLimit ? 'Rate Limit' : 'Transient'}). Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        if (isRateLimit) backoffMs *= 1.5;
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries reached");
};

const fetchImageWithRetry = async (url: string, retries = 8, delay = 3000) => {
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (response.ok) return response;
      if (response.status === 429 || response.status >= 500) {
        console.warn(`Image provider error (${response.status}). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 1.5;
        continue;
      }
      throw new Error(`Image provider returned ${response.status}`);
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (i === retries - 1) throw error;
      
      const isTimeout = error.name === 'AbortError';
      console.warn(`${isTimeout ? 'Request timed out' : 'Fetch failed'}. Retrying in ${delay}ms...`, error);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 1.5;
    }
  }
  throw new Error("Failed to fetch image after several attempts. The image provider might be busy. Please try again in a moment.");
};

export default function App() {
  const [story, setStory] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAnimated, setIsAnimated] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [visualBible, setVisualBible] = useState('');
  const [error, setError] = useState('');

  const [step, setStep] = useState<'input' | 'preview' | 'assembling' | 'result'>('input');
  const [scenesData, setScenesData] = useState<SceneData[]>([]);
  const [fullAudioData, setFullAudioData] = useState('');
  const [storySeed, setStorySeed] = useState(0);

  const handleGenerateScenes = async () => {
    if (!story.trim()) return;
    
    setIsGenerating(true);
    setError('');
    setVideoUrl('');
    setDownloadUrl('');
    setVisualBible('');
    setProgress(0);
    setStatus('Analyzing story and planning scenes...');
    setStep('input');

    try {
      // Use the environment's Gemini API key for free quota models
      const aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const currentSeed = Math.floor(Math.random() * 1000000);
      setStorySeed(currentSeed);

      setStatus('Generating full story audio...');
      const audioResponse = await generateWithRetry(aiClient, {
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Say cheerfully and slowly: ${story}` }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Puck' } // Child-friendly voice
            }
          }
        }
      });

      let fullAudio = '';
      for (const part of audioResponse.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          fullAudio = part.inlineData.data;
          break;
        }
      }
      if (!fullAudio) throw new Error(`Failed to generate full audio.`);
      setFullAudioData(fullAudio);

      // Calculate audio duration to determine number of scenes (aiming for 4.5s per scene)
      // PCM s16le, 24k, 1ch = 48000 bytes per second
      const audioBytes = (fullAudio.length * 3) / 4;
      const duration = audioBytes / 48000;
      const suggestedNumScenes = Math.ceil(duration / 4.5);

      setStatus(`Analyzing story and planning scenes...`);
      // 1. Break story into scenes using Gemini 3 Flash (Free Tier)
      // We explicitly ask for a "Visual Bible" to ensure continuity
      const response = await generateWithRetry(aiClient, {
        model: "gemini-3-flash-preview",
        contents: `You are a world-class children's cartoon storyboard artist and prompt engineer. 
        Your task is to break this story into scenes for a simple, vibrant 3D cartoon designed for children aged 2 to 5 years old.
        Aim for approximately ${suggestedNumScenes} scenes to match the story's length, but use as many or as few as needed to tell the story effectively.
        
        STRICT CONTINUITY & TODDLER-FRIENDLY RULES:
        1. VISUAL BIBLE: First, define the 'visualBible'. This MUST be a detailed paragraph describing the main characters' exact physical traits (vibrant fur/skin color, simple cute clothing, big expressive eyes) AND the specific background environment that will remain continuous across all scenes.
        2. CHARACTER & BACKGROUND CONSISTENCY: Every character MUST have a unique, unchanging "anchor" trait. The background setting MUST be described consistently in every scene to ensure it looks like the same continuous location.
        3. SCENE PROMPTS: For EVERY scene, the 'imagePrompt' MUST:
           - Start with the EXACT SAME core character and background setting descriptions from the Visual Bible.
           - Describe the specific action in a simple, easy-to-understand way.
           - Use the style: "Vibrant 3D Pixar-style cartoon, simple shapes, bright primary colors, high contrast, Cocomelon-inspired aesthetic, soft rounded edges, cheerful lighting, 8k resolution, masterpiece, toddler-friendly, clean and clear visuals".
           - Avoid complex textures, dark shadows, or realistic photography keywords.
        
        Story: ${story}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              visualBible: { 
                type: Type.STRING,
                description: "The core visual description of characters and setting for the entire story."
              },
              scenes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    imagePrompt: { 
                      type: Type.STRING,
                      description: "The full image generation prompt including character consistency and scene action."
                    }
                  },
                  required: ["imagePrompt"]
                }
              }
            },
            required: ["visualBible", "scenes"]
          }
        }
      });

      const responseData = JSON.parse(response.text || '{}');
      const scenes = responseData.scenes || [];
      if (responseData.visualBible) setVisualBible(responseData.visualBible);
      if (scenes.length === 0) throw new Error("Failed to generate scenes.");

      const newScenesData: SceneData[] = [];

      // 2. Process each scene
      for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const baseProgress = 10 + ((i / scenes.length) * 90);
        setProgress(baseProgress);

        setStatus(`Generating image ${i + 1} of ${scenes.length}...`);
        
        // Small delay between scenes to prevent rate limiting
        if (i > 0) await new Promise(resolve => setTimeout(resolve, 1000));

        // Use Pollinations AI for high-throughput image generation
        // We trust the model's prompt for continuity, but add a final quality wrapper
        const prompt = encodeURIComponent(`${scene.imagePrompt}, simple 3D cartoon, vibrant colors, clean lines, high contrast, toddler friendly, 8k, masterpiece`);
        const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?width=1280&height=720&nologo=true&model=flux&seed=${currentSeed}`;
        
        try {
          const imgRes = await fetchImageWithRetry(imageUrl);
          
          const contentType = imgRes.headers.get('content-type');
          if (contentType && !contentType.startsWith('image/')) {
            throw new Error(`Expected image but received ${contentType}`);
          }

          const blob = await imgRes.blob();
          const base64Image = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64 = (reader.result as string).split(',')[1];
              resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          newScenesData.push({ prompt: scene.imagePrompt, image: base64Image });
        } catch (imgErr) {
          console.error(`Error generating image ${i + 1}:`, imgErr);
          throw new Error(`Failed to generate image for scene ${i + 1}. Please try again.`);
        }
      }

      setScenesData(newScenesData);
      setStep('preview');
      setIsGenerating(false);
      
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unknown error occurred');
      setIsGenerating(false);
    }
  };

  const handleRegenerateImage = async (index: number) => {
    const scene = scenesData[index];
    if (!scene) return;

    const updatedScenes = [...scenesData];
    updatedScenes[index].isRegenerating = true;
    setScenesData(updatedScenes);
    setError('');

    try {
      const newSeed = Math.floor(Math.random() * 1000000);
      const prompt = encodeURIComponent(`${scene.prompt}, simple 3D cartoon, vibrant colors, clean lines, high contrast, toddler friendly, 8k, masterpiece`);
      const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?width=1280&height=720&nologo=true&model=flux&seed=${newSeed}`;
      
      const imgRes = await fetchImageWithRetry(imageUrl);
      const blob = await imgRes.blob();
      const base64Image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      const finalScenes = [...scenesData];
      finalScenes[index] = { ...finalScenes[index], image: base64Image, isRegenerating: false };
      setScenesData(finalScenes);
    } catch (err: any) {
      console.error(err);
      setError(`Failed to regenerate image ${index + 1}`);
      const revertedScenes = [...scenesData];
      revertedScenes[index].isRegenerating = false;
      setScenesData(revertedScenes);
    }
  };

  const handleAssembleVideo = async () => {
    setIsGenerating(true);
    setStatus('Starting video assembly...');
    setProgress(0);
    setError('');
    setStep('assembling');

    try {
      const processedImages = scenesData.map(s => s.image);
      const res = await fetch('/api/assemble-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: processedImages, fullAudio: fullAudioData, isAnimated })
      });
      
      if (!res.ok) {
        throw new Error(`Failed to start video assembly: ${res.statusText}`);
      }
      
      const { jobId } = await res.json();
      
      let isDone = false;
      let pollCount = 0;
      const maxPolls = 120; // 2 minutes max polling

      while (!isDone && pollCount < maxPolls) {
        pollCount++;
        await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2s

        const statusRes = await fetch(`/api/job-status/${jobId}`);
        if (!statusRes.ok) throw new Error('Failed to check video status');
        
        const job = await statusRes.json();
        
        if (job.status === 'completed') {
          const origin = window.location.origin;
          setVideoUrl(`${origin}${job.videoUrl}`);
          setDownloadUrl(`${origin}${job.downloadUrl}`);
          setStatus('Complete!');
          setProgress(100);
          setStep('result');
          isDone = true;
        } else if (job.status === 'failed') {
          throw new Error(job.error || 'Video assembly failed');
        } else {
          setProgress(job.progress);
          setStatus(`Assembling video... (${job.progress}%)`);
        }
      }

      if (!isDone) {
        throw new Error('Video assembly timed out. Please try again.');
      }
      
      setIsGenerating(false);
      
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unknown error occurred');
      setIsGenerating(false);
      setStep('preview'); // Go back to preview on error
    }
  };

  return (
    <div className="min-h-screen bg-sky-100 font-sans text-slate-800 p-4 md:p-8 flex flex-col items-center">
      {/* Header */}
      <motion.div 
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="text-center mb-8"
      >
        <h1 className="text-4xl md:text-6xl font-extrabold text-amber-500 drop-shadow-md flex items-center justify-center gap-4">
          <Sparkles className="w-10 h-10 text-amber-400" />
          StoryToon
          <Sparkles className="w-10 h-10 text-amber-400" />
        </h1>
        <p className="text-lg md:text-xl text-sky-700 mt-2 font-medium">Turn your stories into magical cartoons for kids!</p>
      </motion.div>

      <div className="w-full max-w-4xl bg-white rounded-3xl shadow-xl border-4 border-sky-200 overflow-hidden">
        <div className="p-6 md:p-8">
          
          {step === 'input' && (
            <>
              <StoryInput 
                story={story} 
                setStory={setStory} 
                disabled={isGenerating} 
              />

              {/* Animation Toggle */}
              <div className="flex items-start gap-4 mt-4 mb-6 p-4 bg-sky-50 rounded-2xl border-2 border-sky-100">
                <div className="pt-1">
                  <input 
                    type="checkbox" 
                    id="animate-toggle"
                    checked={isAnimated}
                    onChange={(e) => setIsAnimated(e.target.checked)}
                    disabled={isGenerating}
                    className="w-6 h-6 text-amber-500 rounded focus:ring-amber-400 cursor-pointer"
                  />
                </div>
                <div className="flex flex-col">
                  <label htmlFor="animate-toggle" className="font-bold text-sky-900 cursor-pointer flex items-center gap-2 text-lg">
                    <Film className="w-5 h-5 text-amber-500" />
                    Dynamic Camera (Zoom Only)
                  </label>
                  <span className="text-sm text-sky-700 mt-1 leading-relaxed">
                    Applies a smooth, cinematic center-zoom effect to each scene to make the cartoon feel alive. 
                    <br/><strong>Note:</strong> This is a free alternative to AI video generation and processes much faster!
                  </span>
                </div>
              </div>

              {/* Generate Button */}
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleGenerateScenes}
                disabled={isGenerating || !story.trim()}
                className={`w-full py-4 rounded-2xl font-bold text-xl shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 transition-all ${
                  isGenerating || !story.trim()
                    ? 'bg-slate-200 text-slate-400'
                    : 'bg-gradient-to-r from-amber-400 to-orange-500 text-white'
                }`}
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-6 h-6 animate-spin" />
                    Making Magic...
                  </>
                ) : (
                  <>
                    <Play className="w-6 h-6 fill-current" />
                    Create My Cartoon!
                  </>
                )}
              </motion.button>
            </>
          )}

          {step === 'preview' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold text-sky-900">Preview Scenes</h2>
                <span className="text-sky-600 font-medium">{scenesData.length} scenes generated</span>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {scenesData.map((scene, index) => (
                  <div key={index} className="bg-slate-50 rounded-2xl p-4 border-2 border-slate-200 relative overflow-hidden group">
                    <div className="aspect-video bg-slate-200 rounded-xl overflow-hidden relative mb-3">
                      <img 
                        src={`data:image/png;base64,${scene.image}`} 
                        alt={`Scene ${index + 1}`}
                        className={`w-full h-full object-cover transition-opacity ${scene.isRegenerating ? 'opacity-50' : 'opacity-100'}`}
                      />
                      {scene.isRegenerating && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                          <Loader2 className="w-8 h-8 text-white animate-spin" />
                        </div>
                      )}
                    </div>
                    <p className="text-sm text-slate-600 line-clamp-3 mb-4" title={scene.prompt}>
                      {scene.prompt}
                    </p>
                    <button
                      onClick={() => handleRegenerateImage(index)}
                      disabled={scene.isRegenerating || isGenerating}
                      className="w-full py-2 bg-white border-2 border-sky-200 text-sky-700 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-sky-50 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={`w-4 h-4 ${scene.isRegenerating ? 'animate-spin' : ''}`} />
                      Regenerate Image
                    </button>
                  </div>
                ))}
              </div>

              <div className="pt-6 border-t-2 border-sky-100 mt-8">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleAssembleVideo}
                  disabled={isGenerating || scenesData.some(s => s.isRegenerating)}
                  className="w-full py-4 rounded-2xl font-bold text-xl shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 transition-all bg-gradient-to-r from-green-400 to-emerald-500 text-white"
                >
                  <Check className="w-6 h-6" />
                  Looks Good! Assemble Video
                </motion.button>
              </div>
            </div>
          )}

          {(step === 'assembling' || (isGenerating && step === 'input')) && (
            <div className="mt-8 space-y-6">
              {visualBible && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 bg-amber-50 border-2 border-amber-100 rounded-2xl"
                >
                  <h4 className="text-amber-800 font-bold flex items-center gap-2 mb-2">
                    <Sparkles className="w-4 h-4" />
                    Visual Style Guide
                  </h4>
                  <p className="text-amber-700 text-sm italic leading-relaxed">
                    {visualBible}
                  </p>
                </motion.div>
              )}
              <ProgressIndicator status={status} progress={progress} />
            </div>
          )}

          {error && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-6 p-4 bg-red-100 text-red-700 rounded-2xl border-2 border-red-200 font-medium text-center"
            >
              Oops! {error}
            </motion.div>
          )}

          {step === 'result' && videoUrl && !isGenerating && (
            <div className="mt-8">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-bold text-sky-900">Your Cartoon is Ready!</h2>
                <button 
                  onClick={() => {
                    setStep('input');
                    setStory('');
                    setVideoUrl('');
                    setScenesData([]);
                  }}
                  className="text-sky-600 hover:text-sky-800 font-medium underline"
                >
                  Make Another
                </button>
              </div>
              <VideoPlayer videoUrl={videoUrl} downloadUrl={downloadUrl} />
            </div>
          )}

        </div>
      </div>

      {/* Footer */}
      <div className="mt-8 text-sky-600 text-sm font-medium text-center">
        Powered by Gemini & FFmpeg • StoryToon ✨
      </div>
    </div>
  );
}
