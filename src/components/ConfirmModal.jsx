import PropTypes from 'prop-types';
import useEscapeKey from '../hooks/useEscapeKey';
import Overlay from './Overlay';
import { triggerLightHaptic, triggerHeavyHaptic } from '../utils/haptics';
import './ConfirmModal.css';

export default function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  inputLabel,
  inputPlaceholder = '',
  inputValue = '',
  onInputChange,
  onConfirm,
  onCancel,
  confirmDisabled = false,
}) {
  useEscapeKey(onCancel);

  const handleConfirm = () => {
    void (danger ? triggerHeavyHaptic() : triggerLightHaptic());
    onConfirm();
  };

  return (
    <Overlay>
    <div className="confirm-modal-backdrop" onClick={onCancel}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        {title && <h3 className="confirm-modal-title">{title}</h3>}
        {message && <p className="confirm-modal-message">{message}</p>}
        {inputLabel && (
          <label className="confirm-modal-input-label">
            {inputLabel}
            <input
              type="text"
              className="confirm-modal-input"
              placeholder={inputPlaceholder}
              value={inputValue}
              onChange={(e) => onInputChange?.(e.target.value)}
              autoFocus
            />
          </label>
        )}
        <div className="confirm-modal-actions">
          <button type="button" className="secondary-btn" onClick={onCancel}>{cancelLabel}</button>
          <button
            type="button"
            className={danger ? 'danger-btn' : 'primary-btn'}
            onClick={handleConfirm}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
    </Overlay>
  );
}

ConfirmModal.propTypes = {
  title: PropTypes.string,
  message: PropTypes.string,
  confirmLabel: PropTypes.string,
  cancelLabel: PropTypes.string,
  danger: PropTypes.bool,
  inputLabel: PropTypes.string,
  inputPlaceholder: PropTypes.string,
  inputValue: PropTypes.string,
  onInputChange: PropTypes.func,
  onConfirm: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  confirmDisabled: PropTypes.bool,
};
