import { describe, it, expect } from 'vitest';
import { PHOTO_MESSAGE_REGEX } from './image-extraction.js';

describe('PHOTO_MESSAGE_REGEX', () => {
  // --- Matching cases ---

  it('matches a bare path with no caption', () => {
    const m = '[Photo]: /workspace/group/media/img.jpg'.match(PHOTO_MESSAGE_REGEX);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/workspace/group/media/img.jpg');
    expect(m![2]).toBeUndefined();
  });

  it('matches a path with a single-line caption', () => {
    const m = '[Photo]: /workspace/group/media/img.jpg look at this'.match(PHOTO_MESSAGE_REGEX);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/workspace/group/media/img.jpg');
    expect(m![2]).toBe('look at this');
  });

  it('matches a path with a multi-line caption (the regression case)', () => {
    const content =
      "[Photo]: /Users/dev/Dropbox (Personal)/Developer/nanoclaw/repo/groups/work/media/2026-06-03T13-02-18_attachment.jpg i'm going to provide image of the uplynk platform\nI need to create a presentation for partner.";
    const m = content.match(PHOTO_MESSAGE_REGEX);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(
      '/Users/dev/Dropbox (Personal)/Developer/nanoclaw/repo/groups/work/media/2026-06-03T13-02-18_attachment.jpg',
    );
    expect(m![2]).toContain("i'm going to provide image");
    expect(m![2]).toContain('\n');
    expect(m![2]).toContain('I need to create a presentation');
  });

  it('matches all supported extensions', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif', 'JPG', 'JPEG', 'PNG']) {
      const m = `/workspace/media/file.${ext}`;
      expect(`[Photo]: ${m}`.match(PHOTO_MESSAGE_REGEX)).not.toBeNull();
    }
  });

  it('captures caption that spans three lines', () => {
    const content = '[Photo]: /tmp/test.png line one\nline two\nline three';
    const m = content.match(PHOTO_MESSAGE_REGEX);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/tmp/test.png');
    expect(m![2]).toBe('line one\nline two\nline three');
  });

  // --- Non-matching cases ---

  it('does not match a non-image extension', () => {
    expect('[Photo]: /tmp/file.pdf'.match(PHOTO_MESSAGE_REGEX)).toBeNull();
    expect('[Photo]: /tmp/file.mp4'.match(PHOTO_MESSAGE_REGEX)).toBeNull();
    expect('[Photo]: /tmp/file.txt'.match(PHOTO_MESSAGE_REGEX)).toBeNull();
  });

  it('does not match if the prefix is wrong', () => {
    expect('[Video]: /tmp/file.jpg'.match(PHOTO_MESSAGE_REGEX)).toBeNull();
    expect('Photo: /tmp/file.jpg'.match(PHOTO_MESSAGE_REGEX)).toBeNull();
  });
});
