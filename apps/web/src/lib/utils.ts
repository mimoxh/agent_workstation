import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// 自定义字号、圆角要登记，否则 twMerge 把 text-title 当颜色、和 text-ink 互相吞掉
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['xs', 'sm', 'md', 'title', 'h2', 'display', 'page'],
      radius: ['chip', 'ctl', 'pill', 'btn', 'card', 'pop'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
