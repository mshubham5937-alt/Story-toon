import { motion } from 'motion/react';

interface ProgressIndicatorProps {
  status: string;
  progress: number;
}

export function ProgressIndicator({ status, progress }: ProgressIndicatorProps) {
  return (
    <motion.div 
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      className="mt-8"
    >
      <div className="flex justify-between text-sm font-bold text-sky-600 mb-2">
        <span>{status}</span>
        <span>{Math.round(progress)}%</span>
      </div>
      <div className="h-4 w-full bg-sky-100 rounded-full overflow-hidden">
        <motion.div 
          className="h-full bg-gradient-to-r from-green-400 to-emerald-500"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.5 }}
        />
      </div>
    </motion.div>
  );
}
