'use strict';
// Official US government links allowed in every Mailbox reply (John, Nov 15 2026, 4:41 PM ET: "Allow links to official
// government sites in these answers"). Exact host or a true subdomain only, https only, default port, no user info, so
// lookalikes (fda.gov.evil.com, fda-gov.com, evilfda.gov, https://fda.gov@evil.com) stay blocked. PubMed / NCBI (under
// nih.gov), DOI and safecellularphones.org stay blocked, and study citations stay rfsafe.app study pages only.
const GOV_DOMAINS = Object.freeze(['gao.gov', 'fda.gov', 'fcc.gov', 'epa.gov', 'govinfo.gov', 'congress.gov', 'hhs.gov', 'nih.gov', 'cdc.gov', 'uscourts.gov']);
// Hosts under an allowed domain that are research databases, not agency pages: the study-link rule keeps them blocked.
const BLOCKED_SUB = [/(^|\.)ncbi\.nlm\.nih\.gov$/i, /(^|\.)pubmed\./i, /(^|\.)pmc\./i];
function isOfficialGovUrl(u) {
  let x; try { x = new URL(String(u || '').trim()); } catch { return false; }
  if (x.protocol !== 'https:' || x.username || x.password || (x.port && x.port !== '443')) return false;
  const host = x.hostname.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) return false;
  if (BLOCKED_SUB.some((r) => r.test(host))) return false;
  if (/\/(?:pubmed|pmc)\//i.test(x.pathname)) return false;
  return GOV_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}
// RF Safe's own site rfsafe.app (John, Nov 16 2026, 9:03 PM ET: "add ... rfsafe dot app to call bots list of allowed
// links"; r.65159806 was held for https://rfsafe.app/sar). Exact host rfsafe.app or www.rfsafe.app, any path, https only,
// default port, no user info, so lookalikes (rfsafe.app.evil.com, notrfsafe.app, https://rfsafe.app@evil.com) stay blocked.
const SITE_HOSTS = Object.freeze(['rfsafe.app', 'www.rfsafe.app']);
function isSiteUrl(u) {
  let x; try { x = new URL(String(u || '').trim()); } catch { return false; }
  if (x.protocol !== 'https:' || x.username || x.password || (x.port && x.port !== '443')) return false;
  return SITE_HOSTS.includes(x.hostname.toLowerCase().replace(/\.$/, ''));
}
module.exports = { GOV_DOMAINS, isOfficialGovUrl, SITE_HOSTS, isSiteUrl };
