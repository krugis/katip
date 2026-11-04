-- SPDX-License-Identifier: AGPL-3.0-only
-- Fluent Bit filter (P1-43). Keeps our own services' lines only, and masks what looks like an
-- email address or an IPv4 address before a line reaches Loki. Our services already log ids and
-- not text (packages/shared/src/logger.ts); this catches what slips through, such as a caller's
-- address in a request line. It can't recognise a name.

local ALLOWED = {
  ['policy-gateway'] = true,
  ['console-api'] = true,
  ['identity'] = true,
  ['billing-bridge'] = true,
}

local function mask(s)
  s = string.gsub(s, '[%w%.%%%+%-_]+@[%w%-]+%.[%w%.%-]+', '[email]')
  s = string.gsub(s, '%d+%.%d+%.%d+%.%d+', '[ip]')
  return s
end

function katip_redact(tag, timestamp, record)
  if not ALLOWED[tag] then
    return -1, timestamp, record
  end
  local line = record['log']
  if type(line) ~= 'string' then
    return -1, timestamp, record
  end
  return 1, timestamp, {
    raw = mask(line),
    service = tag,
    stream = record['source'] or 'stdout',
  }
end
