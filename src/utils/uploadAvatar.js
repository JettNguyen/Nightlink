import { supabase } from '../supabase';

/**
 * Upload a compressed avatar blob and update profiles.photo_url.
 * Uses upsert so re-uploading always replaces the previous file.
 * Appends a timestamp to bust browser/WKWebView cache on re-upload.
 */
export const uploadAvatar = async ({ userId, blob }) => {
  const path = `${userId}/avatar.jpg`;

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true });

  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  const photoURL = `${data.publicUrl}?t=${Date.now()}`;

  const { error: profileError } = await supabase
    .from('profiles')
    .update({ photo_url: photoURL })
    .eq('id', userId);

  if (profileError) throw profileError;

  return photoURL;
};

/**
 * Remove a user's avatar photo and clear profiles.photo_url.
 */
export const removeAvatar = async ({ userId }) => {
  // Fire-and-forget the storage delete, since the profile update is authoritative
  await supabase.storage.from('avatars').remove([`${userId}/avatar.jpg`]).catch(() => {});

  const { error } = await supabase
    .from('profiles')
    .update({ photo_url: null })
    .eq('id', userId);

  if (error) throw error;
};
