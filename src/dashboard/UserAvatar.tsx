import React, { useRef } from 'react';

type Size = 'sm' | 'md' | 'lg';

export interface UserAvatarProps {
  imageUrl?: string | null;
  altText?: string;
  size?: Size;
  editable?: boolean;
  onChange?: (file: File) => void;
}

const SIZE_MAP: Record<Size, number> = {
  sm: 32,
  md: 64,
  lg: 96,
};

function initialsFromAltText(alt: string): string {
  const trimmed = alt.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0][0] ?? '';
    const b = parts[parts.length - 1][0] ?? '';
    return (a + b).toUpperCase();
  }
  return trimmed.slice(0, Math.min(2, trimmed.length)).toUpperCase();
}

export const UserAvatar: React.FC<UserAvatarProps> = ({ imageUrl, altText = '', size = 'md', editable = false, onChange }) => {
  const px = SIZE_MAP[size];
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleFileChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f && onChange) onChange(f);
  };

  const wrapperStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    background: 'var(--bg-card)',
    border: `2px solid var(--accent)`,
    boxSizing: 'border-box',
  };

  const imgStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  };

  const initialsStyle: React.CSSProperties = {
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontWeight: 600,
    fontSize: px / 2.5,
  };

  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 44,
    borderRadius: 8,
    marginLeft: 12,
    background: 'transparent',
    border: `1px solid var(--border)`,
    color: 'var(--text-primary)',
  };

  const circleLabel = altText.trim() ? `Avatar for ${altText}` : 'User avatar';
  const initials = initialsFromAltText(altText);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {imageUrl ? (
        <div style={wrapperStyle}>
          <img src={imageUrl} alt={circleLabel} style={imgStyle} />
        </div>
      ) : (
        <div style={wrapperStyle} role="img" aria-label={circleLabel}>
          <span aria-hidden="true" style={initialsStyle}>{initials}</span>
        </div>
      )}

      {editable ? (
        <>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
          <button
            type="button"
            className="profile-avatar-change"
            aria-label="Change profile photo"
            onClick={() => fileInputRef.current?.click()}
            style={{
              ...buttonStyle,
              minWidth: 44,
              minHeight: 44,
              cursor: 'pointer',
              boxSizing: 'border-box',
            }}
            title="Change profile photo"
          >
            <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1 }}>+</span>
          </button>
          <style>{`
            .profile-avatar-change:focus-visible {
              outline: 2px solid var(--accent);
              outline-offset: 2px;
            }
          `}</style>
        </>
      ) : null}
    </div>
  );
};

export default UserAvatar;

