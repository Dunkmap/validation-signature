/* Presenting timestamps in Indian Standard Time.

   Every timestamp is STORED as UTC (an ISO 8601 string ending in Z). That does
   not change and must not: UTC is unambiguous, sorts correctly, survives a
   server moving between regions, and is what Salesforce expects on write-back.

   What changes here is only how a time is SHOWN. A signer in Pune reading
   "06:47" on their certificate when they signed at 12:17 has been handed a
   document that appears to contradict them, and an audit record nobody can
   read at a glance is not much of an audit record.

   So: store UTC, display IST, and always name the zone. A bare "12:17" is
   worse than either - it invites the reader to assume their own zone. */

export const IST_ZONE = 'Asia/Kolkata';
export const IST_LABEL = 'IST';

/* Full date and time, for the certificate and anywhere a signature is
   evidenced: "5 Sep 2026, 12:17:05 IST". Seconds are included because two
   signatures a minute apart should be distinguishable on the record. */
export function formatIst(iso, { withSeconds = true } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
    timeZone: IST_ZONE,
  }).format(d);

  // "5 Sept 2026, 12:17:05" -> "5 Sep 2026, 12:17:05 IST"
  return `${parts.replace('Sept', 'Sep')} ${IST_LABEL}`;
}

/* Date only, for a record name or a filename: "5 Sep 2026". */
export function formatIstDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: IST_ZONE,
  }).format(d).replace('Sept', 'Sep');
}

/* IST alongside the stored UTC, for the certificate's most important lines.

   The signer reads the time they recognise; anyone auditing later, in another
   country or another system, can still see the canonical value the hash and
   the Salesforce record were written against. */
export function formatIstWithUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${formatIst(iso)}  (${d.toISOString()})`;
}
