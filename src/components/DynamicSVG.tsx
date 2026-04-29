import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { cn } from '@/lib/utils';

interface DynamicSVGProps {
  path: string;
  className?: string;
  invertInDarkMode?: boolean;
}

export function DynamicSVG({ path, className, invertInDarkMode = true }: DynamicSVGProps) {
  const [svgContent, setSvgContent] = useState<string>('');

  useEffect(() => {
    const loadSvg = async () => {
      try {
        const response = await fetch(path);
        if (!response.ok) throw new Error('Failed to load SVG');
        const data = await response.text();
        // Remove XML declaration and internal styles
        const cleaned = data
          .replace(/<\?xml.*\?>/g, '')
          .replace(/<style>[\s\S]*?<\/style>/g, '');
        // Sanitize SVG to prevent XSS via malicious SVG payloads
        const sanitized = DOMPurify.sanitize(cleaned, { USE_PROFILES: { svg: true, svgFilters: true } });
        setSvgContent(sanitized);
      } catch (err) {
        console.error('Error loading SVG:', err);
      }
    };
    loadSvg();
  }, [path]);

  if (!svgContent) return null;

  return (
    <div 
      className={cn(
        "flex items-center justify-center",
        className,
        invertInDarkMode && "[&_svg]:w-full [&_svg]:h-full [&_.cls-1]:fill-[#0e1745] dark:[&_.cls-1]:fill-white [&_.cls-2]:fill-[#f540ff]"
      )}
      dangerouslySetInnerHTML={{ __html: svgContent }} 
    />
  );
}
