import { BookOpen } from 'lucide-react';

interface StoryInputProps {
  story: string;
  setStory: (story: string) => void;
  disabled: boolean;
}

export function StoryInput({ story, setStory, disabled }: StoryInputProps) {
  return (
    <div className="mb-6">
      <label className="flex items-center gap-2 text-xl font-bold text-sky-600 mb-3">
        <BookOpen className="w-6 h-6" />
        Write your story here:
      </label>
      <textarea
        value={story}
        onChange={(e) => setStory(e.target.value)}
        placeholder="Once upon a time, a little brave bunny named Pip decided to explore the big green forest..."
        className="w-full h-40 p-4 rounded-2xl border-2 border-sky-100 bg-sky-50 focus:border-amber-400 focus:ring-4 focus:ring-amber-100 transition-all resize-none text-lg"
        disabled={disabled}
      />
    </div>
  );
}
