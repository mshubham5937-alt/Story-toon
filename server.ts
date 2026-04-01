import express from 'express';
import { createServer as createViteServer } from 'vite';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// Set the path to the ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegPath as string);

const app = express();
app.use(express.json({ limit: '500mb' })); // Increase limit for base64 data

const PORT = 3000;

// Job tracking
interface Job {
  id: string;
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

const jobs: Record<string, Job> = {};

// Ensure outputs directory exists at startup with absolute path
const OUTPUTS_BASE_DIR = path.resolve(process.cwd(), 'outputs');
console.log(`Outputs directory: ${OUTPUTS_BASE_DIR}`);
fs.mkdir(OUTPUTS_BASE_DIR, { recursive: true }).catch(err => console.error('Failed to create outputs dir:', err));

// Endpoint to check job status
app.get('/api/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// Endpoint to start video assembly
app.post('/api/assemble-video', async (req, res) => {
  const { images, fullAudio, isAnimated, bgMusicUrl } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0 || !fullAudio) {
    return res.status(400).json({ error: 'Images and fullAudio are required' });
  }

  const jobId = uuidv4();
  const outputDir = path.join(OUTPUTS_BASE_DIR, jobId);
  
  // Initialize job
  jobs[jobId] = {
    id: jobId,
    status: 'processing',
    progress: 0
  };

  // Start processing in background
  processVideo(jobId, outputDir, images, fullAudio, isAnimated, bgMusicUrl).catch(err => {
    console.error(`Job ${jobId} failed:`, err);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = err.message || 'Internal processing error';
  });

  // Return jobId immediately
  res.json({ jobId });
});

async function processVideo(jobId: string, outputDir: string, images: string[], fullAudio: string, isAnimated: boolean, bgMusicUrl?: string) {
  try {
    await fs.mkdir(outputDir, { recursive: true });
    
    // 1. Save full audio
    const audioPath = path.join(outputDir, 'full_audio.pcm');
    const audioBuffer = Buffer.from(fullAudio, 'base64');
    await fs.writeFile(audioPath, audioBuffer);

    // Calculate total duration from PCM data (s16le, 24000Hz, 1 channel)
    const totalDuration = audioBuffer.length / 48000;
    const sceneDuration = totalDuration / images.length;

    console.log(`Job ${jobId}: Total duration: ${totalDuration}s, Scene duration: ${sceneDuration}s`);
    jobs[jobId].progress = 10;

    const videoClips: string[] = [];

    // 2. Process each image into a video clip
    for (let i = 0; i < images.length; i++) {
      const imagePath = path.join(outputDir, `scene_${i}.png`);
      const videoPath = path.join(outputDir, `scene_${i}.mp4`);
      await fs.writeFile(imagePath, Buffer.from(images[i], 'base64'));

      await new Promise((resolve, reject) => {
        let command = ffmpeg().input(imagePath).inputOptions(['-loop', '1']);

        const outOptions = [
          '-c:v libx264',
          `-t ${sceneDuration}`,
          '-pix_fmt yuv420p',
          '-r 25',
          '-preset ultrafast'
        ];
        
        if (isAnimated) {
          // Pure center zoom effect (no panning)
          outOptions.push('-vf', `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='min(zoom+0.0015,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(sceneDuration * 25)}:s=1280x720:fps=25`);
        } else {
          outOptions.push('-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1');
        }

        command
          .outputOptions(outOptions)
          .save(videoPath)
          .on('end', resolve)
          .on('error', (err, stdout, stderr) => {
            console.error(`ffmpeg scene ${i} error:`, stderr);
            reject(new Error(`FFmpeg scene ${i} failed: ${err.message}`));
          });
      });

      videoClips.push(`scene_${i}.mp4`);
      jobs[jobId].progress = 10 + Math.floor((i / images.length) * 40);
    }

    // 3. Concatenate all scene videos
    const concatenatedVideoPath = path.join(outputDir, 'concatenated.mp4');
    const concatTxtPath = path.join(outputDir, 'concat.txt');
    const concatContent = videoClips.map(clip => `file '${path.join(outputDir, clip)}'`).join('\n');
    await fs.writeFile(concatTxtPath, concatContent);

    console.log(`Job ${jobId}: Concatenating scenes...`);
    jobs[jobId].progress = 60;
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatTxtPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions('-c copy')
        .save(concatenatedVideoPath)
        .on('end', resolve)
        .on('error', (err, stdout, stderr) => {
          console.error(`Job ${jobId} concat error:`, stderr);
          reject(new Error(`FFmpeg concat failed: ${err.message}`));
        });
    });

    let localBgMusicPath = '';
    if (bgMusicUrl) {
      localBgMusicPath = path.join(outputDir, 'bg_music.mp3');
      console.log(`Job ${jobId}: Downloading background music from ${bgMusicUrl}...`);
      try {
        const bgRes = await fetch(bgMusicUrl);
        if (bgRes.ok) {
          const bgBuffer = await bgRes.arrayBuffer();
          await fs.writeFile(localBgMusicPath, Buffer.from(bgBuffer));
        } else {
          console.warn(`Job ${jobId}: Failed to download bg music, status ${bgRes.status}`);
          localBgMusicPath = '';
        }
      } catch (e) {
        console.warn(`Job ${jobId}: Error downloading bg music:`, e);
        localBgMusicPath = '';
      }
    }

    // 4. Merge concatenated video with full audio and optional bg music
    const finalVideoPath = path.join(outputDir, 'final.mp4');
    console.log(`Job ${jobId}: Merging audio and video...`);
    jobs[jobId].progress = 80;
    await new Promise((resolve, reject) => {
      let command = ffmpeg().input(concatenatedVideoPath);
      command = command.input(audioPath).inputOptions(['-f s16le', '-ar 24000', '-ac 1']);
      
      let outputOptions = [
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-profile:v high',
        '-level 4.1',
        '-crf 20',
        '-preset medium',
        '-c:a aac',
        '-b:a 192k',
        '-ar 44100',
        '-movflags +faststart',
        '-shortest'
      ];

      if (localBgMusicPath) {
        command = command.input(localBgMusicPath).inputOptions(['-stream_loop', '-1']);
        outputOptions = [
          '-filter_complex', '[1:a]volume=1.0[a1];[2:a]volume=0.15[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=2[a]',
          '-map', '0:v',
          '-map', '[a]',
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-profile:v high',
          '-level 4.1',
          '-crf 20',
          '-preset medium',
          '-c:a aac',
          '-b:a 192k',
          '-ar 44100',
          '-movflags +faststart',
          '-shortest'
        ];
      }

      command
        .outputOptions(outputOptions)
        .save(finalVideoPath)
        .on('end', resolve)
        .on('error', (err, stdout, stderr) => {
          console.error(`Job ${jobId} merge error:`, stderr);
          reject(new Error(`FFmpeg merge failed: ${err.message}`));
        });
    });

    // 5. Verify final video exists
    if (!existsSync(finalVideoPath)) {
      throw new Error('Final video file was not created');
    }
    const stats = await fs.stat(finalVideoPath);
    
    console.log(`Job ${jobId}: Success! Video created (${stats.size} bytes)`);
    
    // Update job status
    jobs[jobId].status = 'completed';
    jobs[jobId].progress = 100;
    jobs[jobId].videoUrl = `/outputs/${jobId}/final.mp4`;
    jobs[jobId].downloadUrl = `/api/download/${jobId}`;

  } catch (err: any) {
    console.error(`Error in processVideo for job ${jobId}:`, err);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = err.message || 'Failed to assemble video';
  }
}

// Vite middleware setup for full-stack app
async function startServer() {
  // Dedicated download endpoint - more reliable than static for downloads
  app.get('/api/download/:jobId', (req, res) => {
    const { jobId } = req.params;
    const finalVideoPath = path.join(OUTPUTS_BASE_DIR, jobId, 'final.mp4');
    console.log(`Download request for job ${jobId}. Path: ${finalVideoPath}`);
    if (existsSync(finalVideoPath)) {
      res.download(finalVideoPath, 'storytoon-cartoon.mp4');
    } else {
      console.error(`Download failed: File not found at ${finalVideoPath}`);
      res.status(404).send('Video not found. It may have been deleted or failed to generate.');
    }
  });

  // Serve generated videos statically - MUST be before SPA fallback
  app.use('/outputs', express.static(OUTPUTS_BASE_DIR, {
    setHeaders: (res, path) => {
      if (path.endsWith('.mp4')) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
      }
    }
  }));
  console.log(`Serving static files from: ${OUTPUTS_BASE_DIR}`);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
