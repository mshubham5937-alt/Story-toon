import { motion } from 'motion/react';
import { Download } from 'lucide-react';

interface VideoPlayerProps {
  videoUrl: string;
  downloadUrl?: string;
}

export function VideoPlayer({ videoUrl, downloadUrl }: VideoPlayerProps) {
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="mt-8 flex flex-col items-center"
    >
      <h3 className="text-2xl font-bold text-center text-emerald-600 mb-4">Your Cartoon is Ready! 🎉</h3>
      <div className="w-full rounded-2xl overflow-hidden border-4 border-emerald-200 shadow-lg bg-black aspect-video">
        <video 
          src={videoUrl} 
          controls 
          autoPlay 
          className="w-full h-full object-contain"
        />
      </div>
      
      <a 
        href={downloadUrl || videoUrl} 
        download="storytoon-cartoon.mp4"
        className="mt-6 inline-flex items-center justify-center gap-2 px-8 py-4 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded-2xl shadow-md hover:shadow-lg transition-all transform hover:-translate-y-1"
      >
        <Download className="w-6 h-6" />
        Download MP4 Video
      </a>

      <p className="mt-4 text-xs text-slate-500 text-center max-w-xs">
        Trouble downloading? Try opening the app in a <strong>new tab</strong> using the button in the top right corner of the AI Studio preview.
      </p>
    </motion.div>
  );
}
