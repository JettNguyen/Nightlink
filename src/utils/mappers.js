// Converts snake_case Supabase rows to the camelCase shape the rest of the app expects.
import { normalizeDreamVisibility } from './privacy';

export const mapProfile = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email || '',
    displayName: row.display_name || 'Dreamer',
    username: row.username || '',
    normalizedUsername: row.normalized_username || '',
    photoURL: row.photo_url || null,
    avatarIcon: row.avatar_icon || null,
    avatarBackground: row.avatar_background || null,
    avatarColor: row.avatar_color || null,
    isAnonymous: row.is_anonymous || false,
    accountVisibility: row.account_visibility || row.settings?.accountVisibility || 'private',
    settings: row.settings || {},
    // Other people's profiles come with bio and tier only, not the settings
    // and plan they come from (see utils/profileReads.js).
    bio: row.bio ?? (typeof row.settings?.bio === 'string' ? row.settings.bio.trim() || null : null),
    subscription: row.subscription || { tier: row.tier === 'premium' ? 'premium' : 'free' },
    aiUsage: row.ai_usage || {},
    premiumEmails: row.premium_emails || [],
    dreamMemory: row.dream_memory || null,
    dreamMemoryUpdatedAt: row.dream_memory_updated_at ? new Date(row.dream_memory_updated_at) : null,
    feedSeenAtMs: row.feed_seen_at_ms || null,
    fcmTokens: row.fcm_tokens || [],
    followingIds: row.following_ids || [],
    followerIds: row.follower_ids || [],
    followingSince: row.following_since || {},
    allowAnonymousSharing: row.allow_anonymous_sharing !== false,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  };
};

export const mapDream = (row) => {
  if (!row) return null;
  const isAnonymous = row.visibility === 'anonymous';
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title || '',
    content: row.content || '',
    visibility: normalizeDreamVisibility(row.visibility || 'private'),
    aiGenerated: row.ai_generated || false,
    aiTitle: row.ai_title || null,
    aiInsights: row.ai_insights || null,
    aiConnections: row.ai_connections || null,
    memoryIndexed: row.memory_indexed || false,
    tags: row.tags || [],
    reactionCounts: row.reaction_counts || {},
    viewerReactions: row.viewer_reactions || {},
    commentCount: row.comment_count ?? 0,
    excludedViewerIds: row.excluded_viewer_ids || [],
    taggedUserIds: row.tagged_user_ids || [],
    taggedUsers: row.tagged_users || [],
    authorUsername: isAnonymous ? null : (row.author_username || null),
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  };
};

export const mapComment = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    dreamId: row.dream_id,
    dreamOwnerId: row.dream_owner_id,
    userId: row.user_id,
    authorDisplayName: row.author_display_name || 'Dreamer',
    authorUsername: row.author_username || '',
    dreamOwnerUsername: row.dream_owner_username || '',
    dreamTitleSnapshot: row.dream_title_snapshot || '',
    content: row.content,
    parentCommentId: row.parent_comment_id || null,
    parentCommentUserId: row.parent_comment_user_id || null,
    mentions: row.mentions || [],
    mentionHandles: row.mention_handles || [],
    activityTargetIds: row.activity_target_ids || [],
    heartCount: row.heart_count || 0,
    heartUserIds: row.heart_user_ids || [],
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  };
};

export const mapActivity = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    targetUserId: row.target_user_id,
    actorId: row.actor_id,
    actorDisplayName: row.actor_display_name || '',
    actorUsername: row.actor_username || '',
    type: row.type,
    emoji: row.emoji || null,
    dreamId: row.dream_id || null,
    dreamOwnerId: row.dream_owner_id || null,
    dreamTitleSnapshot: row.dream_title_snapshot || '',
    commentId: row.comment_id || null,
    read: row.read || false,
    readAt: row.read_at ? new Date(row.read_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
};
