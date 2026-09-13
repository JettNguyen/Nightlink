import PropTypes from 'prop-types';

// Copy that changes with state, in a box that does not. Every wording it can
// take is laid out in the same grid cell, so the box is always as tall as the
// longest of them and nothing below it moves when the words change. Switching
// tabs on a profile used to shift the whole list, because one subtitle wrapped
// to two lines and the other did not.
//
// The swap crossfades rather than cutting, which is the difference between a
// value updating and a page redrawing itself.
export default function SwapText({ value, options, className }) {
  const wordings = options?.length ? options : [value];
  return (
    <span className={className ? `swap-text ${className}` : 'swap-text'}>
      {wordings.map((text) => (
        <span
          key={text}
          className={`swap-text-line${text === value ? ' is-shown' : ''}`}
        >
          {text}
        </span>
      ))}
    </span>
  );
}

SwapText.propTypes = {
  value: PropTypes.string.isRequired,
  options: PropTypes.arrayOf(PropTypes.string),
  className: PropTypes.string
};
