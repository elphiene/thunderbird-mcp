import sqlite3 from 'sqlite3'
import { existsSync } from 'fs'
import { join } from 'path'
import { getProfileDir, parsePrefsJs } from './profile.js'

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  })
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()))
  })
}

function openCalendarDb(profileDir) {
  const path = join(profileDir, 'calendar-data', 'local.sqlite')
  if (!existsSync(path)) return null
  const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY)
  db.configure('busyTimeout', 3000)
  return db
}

// Calendar storage uses PRTime (microseconds since the Unix epoch).
function prTimeToISO(value) {
  if (value === null || value === undefined) return null
  return new Date(Number(value) / 1000).toISOString()
}

function isoToPRTime(iso) {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${iso}`)
  return ms * 1000
}

// ATTENDEE icalString lines look like:
// "ATTENDEE;CN=John Doe;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:john@example.com"
function parseAttendee(icalString) {
  if (!icalString) return null
  const colonIdx = icalString.lastIndexOf(':')
  if (colonIdx === -1) return null
  const params = icalString.slice(0, colonIdx)
  const value = icalString.slice(colonIdx + 1).trim()
  const email = value.toLowerCase().startsWith('mailto:') ? value.slice('mailto:'.length) : value

  const cnMatch = /CN=([^;:]+)/i.exec(params)
  const statusMatch = /PARTSTAT=([^;:]+)/i.exec(params)

  return {
    email,
    name: cnMatch ? cnMatch[1].replace(/^"|"$/g, '') : null,
    status: statusMatch ? statusMatch[1] : null,
  }
}

/**
 * Lists all configured calendars (from prefs.js — no database access, works
 * regardless of whether Thunderbird is running).
 */
export function listCalendars() {
  const prefs = parsePrefsJs(getProfileDir())
  const ids = new Set()

  for (const key of prefs.keys()) {
    const match = /^calendar\.registry\.([^.]+)\./.exec(key)
    if (match) ids.add(match[1])
  }

  return [...ids]
    .map((id) => ({
      id,
      name: prefs.get(`calendar.registry.${id}.name`) ?? null,
      type: prefs.get(`calendar.registry.${id}.type`) ?? null,
      color: prefs.get(`calendar.registry.${id}.color`) ?? null,
      readOnly: prefs.get(`calendar.registry.${id}.readOnly`) ?? false,
      accountEmail: prefs.get(`calendar.registry.${id}.username`) ?? null,
    }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}

/**
 * Lists events from the local calendar cache (calendar-data/local.sqlite),
 * optionally filtered by calendar and date range. Requires Thunderbird to be
 * closed — the cache database is held with an exclusive lock while
 * Thunderbird is running.
 */
export async function listEvents({ calendarId, since, until, limit } = {}) {
  const cappedLimit = Math.min(Math.max(limit ?? 50, 1), 200)
  const calendars = new Map(listCalendars().map((c) => [c.id, c]))

  const db = openCalendarDb(getProfileDir())
  if (!db) return []

  try {
    const conditions = []
    const params = []

    if (calendarId) {
      conditions.push('cal_id = ?')
      params.push(calendarId)
    }
    if (since) {
      conditions.push('event_end >= ?')
      params.push(isoToPRTime(since))
    }
    if (until) {
      conditions.push('event_start <= ?')
      params.push(isoToPRTime(until))
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await all(
      db,
      `SELECT * FROM cal_events ${where} ORDER BY event_start ASC LIMIT ?`,
      [...params, cappedLimit]
    )

    const events = []
    for (const row of rows) {
      const [properties, attendees, recurrence] = await Promise.all([
        all(db, 'SELECT key, value FROM cal_properties WHERE item_id = ? AND cal_id = ?', [row.id, row.cal_id]),
        all(db, 'SELECT icalString FROM cal_attendees WHERE item_id = ? AND cal_id = ?', [row.id, row.cal_id]),
        all(db, 'SELECT 1 FROM cal_recurrence WHERE item_id = ? AND cal_id = ? LIMIT 1', [row.id, row.cal_id]),
      ])
      const props = Object.fromEntries(properties.map((p) => [p.key, p.value]))

      events.push({
        id: row.id,
        calendarId: row.cal_id,
        calendarName: calendars.get(row.cal_id)?.name ?? row.cal_id,
        title: row.title,
        location: props.LOCATION ?? null,
        description: props.DESCRIPTION ?? null,
        start: prTimeToISO(row.event_start),
        startTimezone: row.event_start_tz,
        end: prTimeToISO(row.event_end),
        endTimezone: row.event_end_tz,
        status: row.ical_status || null,
        recurring: recurrence.length > 0,
        attendees: attendees.map((a) => parseAttendee(a.icalString)).filter(Boolean),
      })
    }

    return events
  } catch (error) {
    if (error.code === 'SQLITE_BUSY' || /database is locked/i.test(error.message)) {
      throw new Error('Calendar database is locked — close Thunderbird and try again.')
    }
    throw error
  } finally {
    await closeDb(db)
  }
}
