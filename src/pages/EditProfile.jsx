import { useState, useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faCamera, faTrash } from '@fortawesome/free-solid-svg-icons';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { supabase } from '../supabase';
import { mapProfile } from '../utils/mappers';
import { AVATAR_ICONS, AVATAR_BACKGROUNDS, AVATAR_COLORS } from '../constants/avatarOptions';
import LoadingIndicator from '../components/LoadingIndicator';
import Toast from '../components/Toast';
import PhotoCropModal from '../components/PhotoCropModal';
import AvatarDisplay from '../components/AvatarDisplay';
import { uploadAvatar, removeAvatar } from '../utils/uploadAvatar';
import { clearUserSummaryCache } from '../services/UserService';
import { triggerSuccessHaptic, triggerErrorHaptic } from '../utils/haptics';
import { appUserPropType } from '../propTypes';
import './Profile.css';
import './Legal.css';

// Matches the rule enforced at sign-up; `normalized_username` is unique in the
// schema, so an invalid or taken handle otherwise fails with a generic error.
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export default function EditProfile({ user }) {
  const navigate = useNavigate();
  const isNativeIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
  const [userData, setUserData] = useState(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [avatarIcon, setAvatarIcon] = useState(AVATAR_ICONS[0].id);
  const [avatarBackground, setAvatarBackground] = useState(AVATAR_BACKGROUNDS[0]);
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[0]);
  const [accountVisibility, setAccountVisibility] = useState('private');

  const [photoFile, setPhotoFile] = useState(null);
  const [photoBlob, setPhotoBlob] = useState(null);
  const [photoPreviewURL, setPhotoPreviewURL] = useState(null);
  const [removePhotoFlag, setRemovePhotoFlag] = useState(false);
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const fileInputRef = useRef(null);
  const privateAccountEnabled = accountVisibility === 'private';

  const handleAccountVisibilityToggle = (event) => {
    setAccountVisibility(event.target.checked ? 'private' : 'public');
  };

  // Measured against what was loaded, so the bar can say whether there is
  // anything to save rather than offering to save nothing.
  const hasChanges = Boolean(userData) && (
    displayName !== (userData.displayName || '')
    || username !== (userData.username || '')
    || bio !== (userData.settings?.bio || '')
    || avatarIcon !== (userData.avatarIcon || AVATAR_ICONS[0].id)
    || avatarBackground !== (userData.avatarBackground || AVATAR_BACKGROUNDS[0])
    || avatarColor !== (userData.avatarColor || AVATAR_COLORS[0])
    || accountVisibility !== (userData.accountVisibility || userData.settings?.accountVisibility || 'private')
    || Boolean(photoBlob)
    || removePhotoFlag
  );

  const handleDiscard = () => {
    if (!userData) return;
    if (photoPreviewURL && photoPreviewURL !== userData.photoURL) {
      URL.revokeObjectURL(photoPreviewURL);
    }
    setDisplayName(userData.displayName || '');
    setUsername(userData.username || '');
    setBio(userData.settings?.bio || '');
    setAvatarIcon(userData.avatarIcon || AVATAR_ICONS[0].id);
    setAvatarBackground(userData.avatarBackground || AVATAR_BACKGROUNDS[0]);
    setAvatarColor(userData.avatarColor || AVATAR_COLORS[0]);
    setAccountVisibility(userData.accountVisibility || userData.settings?.accountVisibility || 'private');
    setPhotoPreviewURL(userData.photoURL || null);
    setPhotoFile(null);
    setPhotoBlob(null);
    setRemovePhotoFlag(false);
    setUsernameError('');
    setUploadError('');
  };

  useEffect(() => {
    if (!user?.uid) { navigate('/profile', { replace: true }); return; }
    supabase.from('profiles').select('*').eq('id', user.uid).single()
      .then(({ data }) => {
        if (!data) { navigate('/profile', { replace: true }); return; }
        const p = mapProfile(data);
        setUserData(p);
        setDisplayName(p.displayName || '');
        setUsername(p.username || '');
        setBio(p.settings?.bio || '');
        setAvatarIcon(p.avatarIcon || AVATAR_ICONS[0].id);
        setAvatarBackground(p.avatarBackground || AVATAR_BACKGROUNDS[0]);
        setAvatarColor(p.avatarColor || AVATAR_COLORS[0]);
        setAccountVisibility(p.accountVisibility || p.settings?.accountVisibility || 'private');
        setPhotoPreviewURL(p.photoURL || null);
        setPageLoading(false);
      });
  }, [user?.uid, navigate]);

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { setUploadError('Please select an image file.'); return; }
    if (file.size > 10 * 1024 * 1024) { setUploadError('Image must be under 10 MB.'); return; }
    setUploadError('');
    setPhotoFile(file);
    setCropModalOpen(true);
    // Reset input so selecting the same file again still fires onChange
    e.target.value = '';
  };

  const handleCropConfirm = (blob) => {
    const previewURL = URL.createObjectURL(blob);
    // Revoke previous preview URL to avoid memory leaks
    if (photoPreviewURL && photoPreviewURL !== userData?.photoURL) {
      URL.revokeObjectURL(photoPreviewURL);
    }
    setPhotoBlob(blob);
    setPhotoPreviewURL(previewURL);
    setRemovePhotoFlag(false);
    setCropModalOpen(false);
    setPhotoFile(null);
  };

  const handleRemovePhoto = () => {
    if (photoPreviewURL && photoPreviewURL !== userData?.photoURL) {
      URL.revokeObjectURL(photoPreviewURL);
    }
    setPhotoPreviewURL(null);
    setPhotoBlob(null);
    setRemovePhotoFlag(true);
    setUploadError('');
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!user?.uid || !userData) return;

    const nextUsername = username.trim() || userData.username;
    const nextNormalized = nextUsername.toLowerCase();
    const usernameChanged = nextNormalized !== (userData.username || '').toLowerCase();

    if (!USERNAME_RE.test(nextUsername)) {
      setUsernameError('3 to 20 chars: letters, numbers, underscores.');
      return;
    }

    setSaving(true);
    setUploadError('');
    setUsernameError('');
    try {
      if (usernameChanged) {
        const { data: taken } = await supabase
          .from('profiles')
          .select('id')
          .eq('normalized_username', nextNormalized)
          .maybeSingle();
        if (taken && taken.id !== user.uid) {
          setUsernameError('That username is already taken.');
          setSaving(false);
          return;
        }
      }

      if (photoBlob) {
        await uploadAvatar({ userId: user.uid, blob: photoBlob });
        clearUserSummaryCache();
      } else if (removePhotoFlag && userData.photoURL) {
        await removeAvatar({ userId: user.uid });
        clearUserSummaryCache();
      }

      const { error } = await supabase.from('profiles').update({
        display_name:        displayName.trim(),
        username:            nextUsername,
        normalized_username: nextNormalized,
        avatar_icon:         avatarIcon,
        avatar_background:   avatarBackground,
        avatar_color:        avatarColor,
        account_visibility:  accountVisibility,
        settings:            { ...(userData.settings || {}), bio: bio.trim() || null, accountVisibility },
      }).eq('id', user.uid);
      if (error) throw error;
      void triggerSuccessHaptic();
      navigate('/profile', { replace: true });
    } catch (err) {
      // 23505 = unique violation, i.e. the handle was claimed between the
      // availability check and the write.
      if (err?.code === '23505') setUsernameError('That username is already taken.');
      else { void triggerErrorHaptic(); setToast('Failed to update profile.'); }
    }
    setSaving(false);
  };

  if (pageLoading) {
    return (
      <div className="page-container">
        <div className="profile-loading loading-slot"><LoadingIndicator label="Loading…" size="lg" /></div>
      </div>
    );
  }

  return (
    <div className="page-container">
      {!isNativeIOS && (
        <button type="button" className="legal-back-btn" onClick={() => navigate('/profile')}>
          <FontAwesomeIcon icon={faChevronLeft} style={{ marginRight: '0.4rem' }} />
          Profile
        </button>
      )}

      <div className="page-header search-header">
        <div>
          <h1>Edit Profile</h1>
          <p className="page-subtitle">Customize your appearance.</p>
        </div>
      </div>

      {!pageLoading && (
        <div className="save-bar">
          <p>{hasChanges ? 'You have unsaved changes' : 'All changes saved'}</p>
          <div className="btn-group">
            <button type="button" className="ghost-btn" onClick={handleDiscard} disabled={saving || !hasChanges}>
              Discard
            </button>
            <button
              type="submit"
              form="profile-edit-form"
              className={`primary-btn${saving ? ' is-loading' : ''}`}
              disabled={saving || !hasChanges}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <form id="profile-edit-form" onSubmit={handleSave} className="profile-edit-form">
        <div className="profile-field">
          <label htmlFor="ep-display-name" className="profile-field-label">Display name</label>
          <input
            id="ep-display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your display name"
            required
            className="profile-input"
          />
        </div>
        <div className="profile-field">
          <label htmlFor="ep-username" className="profile-field-label">Username</label>
          <input
            id="ep-username"
            type="text"
            value={username}
            onChange={(e) => { setUsername(e.target.value); setUsernameError(''); }}
            placeholder="your_username"
            className="profile-input"
            aria-invalid={Boolean(usernameError)}
            aria-describedby="ep-username-hint"
          />
          <p id="ep-username-hint" className={usernameError ? 'photo-upload-error' : 'page-subtitle'}>
            {usernameError || '3 to 20 characters: letters, numbers, and underscores.'}
          </p>
        </div>
        {userData?.email && (
          <div className="profile-field">
            <label htmlFor="ep-email" className="profile-field-label">Email</label>
            <input
              id="ep-email"
              type="email"
              value={userData.email}
              className="profile-input"
              readOnly
              disabled
            />
          </div>
        )}
        <div className="profile-field">
          <label htmlFor="ep-bio" className="profile-field-label">Bio</label>
          <textarea
            id="ep-bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Tell others a little about yourself…"
            rows={4}
            className="profile-textarea"
          />
        </div>

        <div className="profile-field">
          <label htmlFor="ep-private-account" className="profile-field-label">Private account</label>
          <div className="profile-toggle-row">
            <label className="profile-toggle-switch" htmlFor="ep-private-account">
              <input
                id="ep-private-account"
                type="checkbox"
                checked={privateAccountEnabled}
                onChange={handleAccountVisibilityToggle}
                aria-label="Private account"
              />
              <span className="profile-toggle-track" />
            </label>
            <span className="profile-toggle-label">Require follow approval for non-public profile access</span>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          aria-hidden="true"
        />

        <div className="photo-upload-section">
          <p className="customizer-label">Profile photo</p>
          <div className="photo-upload-body">
            <AvatarDisplay
              photoURL={removePhotoFlag ? null : photoPreviewURL}
              avatarIcon={avatarIcon}
              avatarBackground={avatarBackground}
              avatarColor={avatarColor}
              className="avatar-circle photo-upload-preview"
              aria-label="Profile photo preview"
            />
            <div className="photo-upload-actions">
              <button
                type="button"
                className="ghost-btn photo-upload-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                <FontAwesomeIcon icon={faCamera} />
                {photoPreviewURL && !removePhotoFlag ? 'Change photo' : 'Upload photo'}
              </button>
              {(photoPreviewURL && !removePhotoFlag) && (
                <button
                  type="button"
                  className="ghost-btn photo-remove-btn"
                  onClick={handleRemovePhoto}
                  aria-label="Remove photo"
                >
                  <FontAwesomeIcon icon={faTrash} />
                  Remove
                </button>
              )}
            </div>
          </div>
          {uploadError && <p className="photo-upload-error">{uploadError}</p>}
        </div>

        <div className="photo-avatar-divider">
          <span>or customize avatar</span>
        </div>

        <div className="avatar-customizer">
          <p className="customizer-label">Avatar icon</p>
          <div className="avatar-option-grid">
            {AVATAR_ICONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`avatar-option${avatarIcon === option.id ? ' selected' : ''}`}
                aria-pressed={avatarIcon === option.id}
                onClick={() => setAvatarIcon(option.id)}
              >
                <FontAwesomeIcon icon={option.icon} /><span>{option.label}</span>
              </button>
            ))}
          </div>

          <p className="customizer-label">Background</p>
          <div className="color-swatch-grid">
            {AVATAR_BACKGROUNDS.map((color) => (
              <button
                key={color}
                type="button"
                className={`color-swatch${avatarBackground === color ? ' selected' : ''}`}
                style={{ background: color }}
                onClick={() => setAvatarBackground(color)}
                aria-pressed={avatarBackground === color}
                aria-label={`Select background ${color}`}
              />
            ))}
          </div>

          <p className="customizer-label">Icon color</p>
          <div className="color-swatch-grid">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`color-swatch${avatarColor === color ? ' selected' : ''}`}
                style={{ background: color }}
                onClick={() => setAvatarColor(color)}
                aria-pressed={avatarColor === color}
                aria-label={`Select icon color ${color}`}
              />
            ))}
          </div>
        </div>
      </form>

      <Toast message={toast} onDismiss={() => setToast('')} />

      {cropModalOpen && photoFile && (
        <PhotoCropModal
          file={photoFile}
          onConfirm={handleCropConfirm}
          onCancel={() => { setCropModalOpen(false); setPhotoFile(null); }}
        />
      )}
    </div>
  );
}

EditProfile.propTypes = {
  user: appUserPropType,
};
