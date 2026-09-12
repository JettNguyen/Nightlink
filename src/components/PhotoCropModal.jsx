import { useState, useEffect, useRef, useCallback } from 'react';
import PropTypes from 'prop-types';
import Overlay from './Overlay';
import { compressImage } from '../utils/imageUtils';
import useEscapeKey from '../hooks/useEscapeKey';
import './PhotoCropModal.css';

const MASK_SIZE = 240;
const MIN_SCALE = 1.0;
const MAX_SCALE = 4.0;

function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function computeDisplaySize(naturalWidth, naturalHeight, scale) {
  const base = Math.max(MASK_SIZE / naturalWidth, MASK_SIZE / naturalHeight);
  return {
    w: naturalWidth * base * scale,
    h: naturalHeight * base * scale,
  };
}

function clampOffset(x, y, displayW, displayH) {
  return {
    x: Math.min(0, Math.max(MASK_SIZE - displayW, x)),
    y: Math.min(0, Math.max(MASK_SIZE - displayH, y)),
  };
}

function getCropRect(naturalWidth, naturalHeight, displayW, displayH, offsetX, offsetY) {
  return {
    x: (-offsetX / displayW) * naturalWidth,
    y: (-offsetY / displayH) * naturalHeight,
    width: (MASK_SIZE / displayW) * naturalWidth,
    height: (MASK_SIZE / displayH) * naturalHeight,
  };
}

export default function PhotoCropModal({ file, onConfirm, onCancel }) {
  const [naturalSize, setNaturalSize] = useState(null);
  const [scale, setScale] = useState(MIN_SCALE);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const objectURL = useRef(null);
  const maskRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    objectURL.current = url;
    const img = new Image();
    img.onload = () => {
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      setNaturalSize({ width: nw, height: nh });
      const { w, h } = computeDisplaySize(nw, nh, MIN_SCALE);
      setOffset(clampOffset((MASK_SIZE - w) / 2, (MASK_SIZE - h) / 2, w, h));
      setScale(MIN_SCALE);
    };
    img.src = url;
    return () => { URL.revokeObjectURL(url); objectURL.current = null; };
  }, [file]);

  const { w: displayW, h: displayH } = naturalSize
    ? computeDisplaySize(naturalSize.width, naturalSize.height, scale)
    : { w: MASK_SIZE, h: MASK_SIZE };

  // Re-clamp when scale changes so the image always covers the mask
  const applyScale = useCallback((newScale) => {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    setScale(clamped);
    setOffset((prev) => {
      if (!naturalSize) return prev;
      const { w, h } = computeDisplaySize(naturalSize.width, naturalSize.height, clamped);
      return clampOffset(prev.x, prev.y, w, h);
    });
  }, [naturalSize]);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragRef.current?.active) return;
      const newX = e.clientX - dragRef.current.startX;
      const newY = e.clientY - dragRef.current.startY;
      if (!naturalSize) return;
      const { w, h } = computeDisplaySize(naturalSize.width, naturalSize.height, scale);
      setOffset(clampOffset(newX, newY, w, h));
    };
    const onUp = () => { if (dragRef.current) dragRef.current.active = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [naturalSize, scale]);

  const handleMouseDown = (e) => {
    dragRef.current = { active: true, startX: e.clientX - offset.x, startY: e.clientY - offset.y };
  };

  // Must be non-passive to call preventDefault and block scroll
  useEffect(() => {
    const mask = maskRef.current;
    if (!mask) return;

    const onTouchStart = (e) => {
      if (e.touches.length === 1) {
        dragRef.current = {
          mode: 'drag',
          startX: e.touches[0].clientX - offset.x,
          startY: e.touches[0].clientY - offset.y,
        };
      } else if (e.touches.length === 2) {
        dragRef.current = {
          mode: 'pinch',
          initDist: getTouchDist(e.touches),
          initScale: scale,
        };
      }
    };

    const onTouchMove = (e) => {
      e.preventDefault();
      if (!dragRef.current || !naturalSize) return;
      if (dragRef.current.mode === 'drag' && e.touches.length === 1) {
        const newX = e.touches[0].clientX - dragRef.current.startX;
        const newY = e.touches[0].clientY - dragRef.current.startY;
        const { w, h } = computeDisplaySize(naturalSize.width, naturalSize.height, scale);
        setOffset(clampOffset(newX, newY, w, h));
      } else if (dragRef.current.mode === 'pinch' && e.touches.length === 2) {
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
          dragRef.current.initScale * (getTouchDist(e.touches) / dragRef.current.initDist)
        ));
        applyScale(newScale);
      }
    };

    const onTouchEnd = () => { dragRef.current = null; };

    mask.addEventListener('touchstart', onTouchStart, { passive: true });
    mask.addEventListener('touchmove', onTouchMove, { passive: false });
    mask.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      mask.removeEventListener('touchstart', onTouchStart);
      mask.removeEventListener('touchmove', onTouchMove);
      mask.removeEventListener('touchend', onTouchEnd);
    };
  }, [naturalSize, scale, offset, applyScale]);

  useEscapeKey(onCancel, !loading);

  const handleConfirm = async () => {
    if (!naturalSize || !file) return;
    setLoading(true);
    setError('');
    try {
      const cropRect = getCropRect(
        naturalSize.width, naturalSize.height,
        displayW, displayH,
        offset.x, offset.y,
      );
      const blob = await compressImage({ file, cropRect });
      onConfirm(blob);
    } catch {
      setError('Could not process image. Please try another photo.');
    }
    setLoading(false);
  };

  return (
    <Overlay>
    <div className="crop-modal-backdrop" role="dialog" aria-modal="true" aria-label="Crop profile photo">
      <div className="crop-modal-card">
        <h2 className="crop-modal-title">Crop photo</h2>
        <p className="crop-modal-hint">Drag to reposition · pinch or slider to zoom</p>

        <div className="crop-mask-outer">
          <div
            ref={maskRef}
            className="crop-mask"
            onMouseDown={handleMouseDown}
            role="img"
            aria-label="Crop preview"
          >
            {objectURL.current && naturalSize && (
              <img
                src={objectURL.current}
                alt=""
                draggable={false}
                style={{
                  width: `${displayW}px`,
                  height: `${displayH}px`,
                  left: `${offset.x}px`,
                  top: `${offset.y}px`,
                }}
              />
            )}
          </div>
          <div className="crop-mask-ring" aria-hidden="true" />
        </div>

        <div className="crop-zoom-row">
          <span className="crop-zoom-label">Zoom</span>
          <input
            type="range"
            className="crop-zoom-slider"
            min={MIN_SCALE}
            max={MAX_SCALE}
            step={0.01}
            value={scale}
            onChange={(e) => applyScale(parseFloat(e.target.value))}
            aria-label="Zoom level"
          />
        </div>

        {error && <p className="crop-error">{error}</p>}

        <div className="crop-modal-actions">
          <button type="button" className="secondary-btn" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={handleConfirm}
            disabled={loading || !naturalSize}
          >
            {loading ? 'Processing…' : 'Use photo'}
          </button>
        </div>
      </div>
    </div>
    </Overlay>
  );
}

PhotoCropModal.propTypes = {
  file: PropTypes.instanceOf(File).isRequired,
  onConfirm: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};
