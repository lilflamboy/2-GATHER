/**
 * Small reusable Lumiere logo mark used anywhere the UI previously rendered a
 * generic media icon. It keeps the real brand asset consistent across views.
 */
export default function LumiereLogoMark({
  size = 20,
  className = "",
  alt = "",
  ...rest
}) {
  return (
    <img
      src="/lumiere-sync-logo.png"
      alt={alt}
      className={`lumiere-icon-glow block shrink-0 object-contain ${className}`.trim()}
      style={{ width: `${size}px`, height: "auto" }}
      {...rest}
    />
  );
}
