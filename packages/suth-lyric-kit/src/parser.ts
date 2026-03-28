export interface LyricWord {
  text: string;
  startTime: number; // Absolute time in seconds
  duration: number; // Duration in seconds
}

export interface LyricLine {
  time: number; // Start time in seconds
  text: string;
  translation?: string; // Translation text
  words?: LyricWord[];
}

export interface ParsedLyrics {
  lines: LyricLine[];
}

/**
 * Parses LRC content.
 * Supports standard LRC: [mm:ss.xx] Text
 * Supports enhanced LRC with word timestamps: [mm:ss.xx] <mm:ss.xx>Word <mm:ss.xx>Word
 * or simple word grouping if available.
 */
export function parseLyrics(content: string): ParsedLyrics {
  const lines: LyricLine[] = [];
  const rawLines = content.split(/\r?\n/);
  const timeExp = /\[(\d{2}):(\d{2})(\.(\d{2,3}))?\]/;
  
  // Regex for word tags like <00:01.50> or (00:01.50)
  // Simplified: we assume enhanced lrc uses <timestamp> format for words
  const wordTimeExp = /<(\d{2}):(\d{2})(\.(\d{2,3}))?>/g;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for standard timestamp
    const match = timeExp.exec(trimmed);
    if (match) {
      const minutes = parseInt(match[1]!, 10);
      const seconds = parseInt(match[2]!, 10);
      const milliseconds = match[4] ? parseInt(match[4].padEnd(3, '0'), 10) : 0;
      const startTime = minutes * 60 + seconds + milliseconds / 1000;
      
      const textPart = trimmed.replace(timeExp, '').trim();
      
      // Try to parse words if they exist in format <time>text
      // This is a simplified parser for enhanced LRC. 
      // A more robust one would need specific format specs (ESLyric, KRC decoded, etc.)
      // Here we check if the text contains <> tags with timestamps.
      
      const words: LyricWord[] = [];
      let hasWordTags = false;
      
      // We need to reset lastIndex for global regex
      wordTimeExp.lastIndex = 0;
      let wordMatch;
      
      // If text looks like: <00:01.00>Hello <00:01.50>World
      while ((wordMatch = wordTimeExp.exec(textPart)) !== null) {
        hasWordTags = true;
        const wMin = parseInt(wordMatch[1], 10);
        const wSec = parseInt(wordMatch[2], 10);
        const wMs = wordMatch[4] ? parseInt(wordMatch[4].padEnd(3, '0'), 10) : 0;
        const wTime = wMin * 60 + wSec + wMs / 1000;
        
        // The text for this word is until the next tag or end of string
        // Actually, often format is Word<time> or <time>Word. 
        // Let's assume <time>Word pattern for now or parse generic Karaoke.
        // Standard enhanced lrc: [mm:ss.xx] <mm:ss.xx>Word1 <mm:ss.xx>Word2
        
        const nextTagIndex = textPart.indexOf('<', wordMatch.index + 1);
        const contentEndIndex = nextTagIndex === -1 ? textPart.length : nextTagIndex;
        const wordText = textPart.substring(wordMatch.index + wordMatch[0].length, contentEndIndex).trim();
        
        if (wordText) {
             words.push({
                text: wordText,
                startTime: wTime,
                duration: 0 // We'll calculate duration based on next word
            });
        }
      }

      if (hasWordTags) {
          // Calculate durations
          for (let i = 0; i < words.length; i++) {
              if (i < words.length - 1) {
                  words[i].duration = words[i+1].startTime - words[i].startTime;
              } else {
                  // Last word, hard to guess duration, assume arbitrary or until next line
                  words[i].duration = 0.5; // Default 0.5s
              }
          }
      }

      lines.push({
        time: startTime,
        text: textPart.replace(/<[^>]+>/g, ''), // Clean text for fallback
        words: words.length > 0 ? words : undefined
      });
    }
  }

  // Sort by time just in case
  lines.sort((a, b) => a.time - b.time);
  
  return { lines };
}

/**
 * Parses TTML format for word-level lyrics
 */
export function parseTtml(ttmlContent: string): ParsedLyrics {
  const lines: LyricLine[] = [];
  const bgLines: { time: number; text: string }[] = [];
  
  // Simple regex-based parser for TTML
  // Looking for <p begin="..." end="..."> containing <span> tags
  
  // Clean up content: we used to replace newlines with spaces, but that breaks CJK text.
  // Now we use robust regexes that handle multiline attributes and content.
  const cleanContent = ttmlContent;
  
  // Regex to match p tags and capture attributes and content
  // Use [\s\S] to match newlines if cleanContent didn't remove them, or just to be safe
  const pTagRegex = /<p(\s+[^>]*?)>([\s\S]*?)<\/p>/g;
  
  // Robust span regex: match the tag and capture attributes area and content area
  const spanTagRegex = /<span(\s+[^>]*?)>([\s\S]*?)<\/span>/g;
  
  // Helper to parse time string: mm:ss.ms or HH:mm:ss.ms
  const parseTime = (timeStr: string): number => {
    if (!timeStr) return 0;
    // Remove whitespace that might have been introduced by newlines
    const cleanTimeStr = timeStr.replace(/\s/g, '');
    const parts = cleanTimeStr.split(':');
    let seconds = 0;
    
    if (parts.length === 3) {
      seconds = parseInt(parts[0]!) * 3600 + parseInt(parts[1]!) * 60 + parseFloat(parts[2]!);
    } else if (parts.length === 2) {
      seconds = parseInt(parts[0]!) * 60 + parseFloat(parts[1]!);
    } else {
      seconds = parseFloat(parts[0]!);
    }
    return seconds;
  };

  // Helper to extract attribute value
  const getAttr = (attrs: string, name: string): string | null => {
    // Escape special chars in name
    const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match name="value" or name='value', allowing spaces around =, and value can span lines
    const regex = new RegExp(`${safeName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`);
    const match = regex.exec(attrs);
    return match ? match[2]! : null;
  };

  let pMatch;
  while ((pMatch = pTagRegex.exec(cleanContent)) !== null) {
    const attrs = pMatch[1]!;
    const innerContent = pMatch[2]!;
    
    const beginStr = getAttr(attrs, 'begin');
    if (!beginStr) continue;

    const beginTime = parseTime(beginStr);
    
    // Check for role in various namespaces and values
    const role = getAttr(attrs, 'ttml:role') || getAttr(attrs, 'role') || getAttr(attrs, 'ttm:role');

    const words: LyricWord[] = [];
    let lineText = '';
    
    // Parse spans within p
    let spanMatch;
    // Reset span regex index
    spanTagRegex.lastIndex = 0;
    
    let hasSpans = false;
    while ((spanMatch = spanTagRegex.exec(innerContent)) !== null) {
      hasSpans = true;
      const spanAttrs = spanMatch[1]!;
      const wTextRaw = spanMatch[2];
      
      const beginStr = getAttr(spanAttrs, 'begin');
      const endStr = getAttr(spanAttrs, 'end');
      
      if (beginStr && endStr) {
        const startTime = parseTime(beginStr);
        const endTime = parseTime(endStr);
        // Clean word text
        const wText = (wTextRaw || '').replace(/<br\s*\/?>/g, '').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        
        words.push({
          text: wText,
          startTime,
          duration: endTime - startTime
        });
        
        lineText += wText;
      }
    }
    
    // Fallback if no spans found (just text in p)
    if (!hasSpans) {
      lineText = (innerContent || '').replace(/<br\s*\/?>/g, '\n').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }

    // Check if line is wrapped in parentheses (English or Chinese)
    const trimmedText = lineText.trim();
    const isWrappedInParentheses = 
        (trimmedText.startsWith('(') && trimmedText.endsWith(')')) ||
        (trimmedText.startsWith('（') && trimmedText.endsWith('）'));

    if (role === 'x-bg' || role === 'translation' || isWrappedInParentheses) {
        // Background line (translation)
        bgLines.push({
            time: beginTime,
            text: lineText
        });
    } else {
        // Main lyric line
        lines.push({
          time: beginTime,
          text: lineText,
          words: words.length > 0 ? words : undefined
        });
    }
  }
  
  // Merge background lines as translations
  for (const bg of bgLines) {
      // Find matching line (allow 0.2s tolerance)
      const mainLine = lines.find(l => Math.abs(l.time - bg.time) < 0.2);
      if (mainLine) {
          // If translation already exists, maybe append? But usually one translation line per main line.
          mainLine.translation = bg.text;
      }
  }
  
  return { lines: lines.sort((a, b) => a.time - b.time) };
}
