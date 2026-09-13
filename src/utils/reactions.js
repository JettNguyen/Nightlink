// One chip per emoji meant a dream that landed well drew a block of counts
// taller than the dream above it: the row wraps, and the picker takes any emoji
// a person can type, so there was no ceiling on how many chips a dream could
// grow. Three glyphs and one total say the same thing at a width that does not
// depend on how many people turned up. The viewer's own leads the cluster, so
// being in on a reaction stays visible without reading any of the numbers.
export const CLUSTER_GLYPH_LIMIT = 3;

export const buildReactionCluster = (counts, viewerReactions, heartEmoji) => {
  const safeCounts = counts || {};
  const entries = Object.entries(safeCounts)
    .filter(([emoji, count]) => (
      typeof emoji === 'string' && emoji.trim().length && emoji !== heartEmoji && count > 0
    ))
    .sort((a, b) => b[1] - a[1]);

  const mine = (viewerReactions || []).filter((emoji) => (
    emoji !== heartEmoji && safeCounts[emoji] > 0
  ));

  const rest = entries.map(([emoji]) => emoji).filter((emoji) => !mine.includes(emoji));

  return {
    entries,
    glyphs: [...mine, ...rest].slice(0, CLUSTER_GLYPH_LIMIT),
    total: entries.reduce((sum, [, count]) => sum + count, 0),
    reacted: mine.length > 0
  };
};
