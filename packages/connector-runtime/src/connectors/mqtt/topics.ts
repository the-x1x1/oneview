/**
 * MQTT topic names and filters (MQTT 3.1.1 §4.7): levels separated by `/`; in a filter `+`
 * stands for exactly one level and `#`, only as the last level, for any number of levels
 * including none (`a/#` matches `a`). A filter starting with a wildcard does not match a
 * topic starting with `$` (`$SYS/…` is the broker's own). The broker does the routing; the
 * connector checks again so a message on a topic it never asked for is counted, not mapped.
 */
export { MAX_TOPIC_LENGTH, checkTopicFilter } from '@worldview/connector-sdk';

/** A topic name a broker delivered: no wildcards, not empty. */
export function isTopicName(topic: string): boolean {
  return topic.length > 0 && !topic.includes('+') && !topic.includes('#');
}

export function topicLevels(topic: string): string[] {
  return topic.split('/');
}

/** Whether `topic` (a name) is matched by `filter`. */
export function topicMatches(filter: string, topic: string): boolean {
  if (!isTopicName(topic)) return false;
  const f = filter.split('/');
  const t = topic.split('/');
  if (topic.startsWith('$') && (f[0] === '+' || f[0] === '#')) return false;
  for (let i = 0; i < f.length; i++) {
    const level = f[i]!;
    if (level === '#') return true;
    if (i >= t.length) return false;
    if (level !== '+' && level !== t[i]) return false;
  }
  return f.length === t.length;
}

/** Whether any of `filters` matches `topic`. */
export function matchesAny(filters: readonly string[], topic: string): boolean {
  return filters.some((f) => topicMatches(f, topic));
}

/**
 * A topic name a filter matches, for a message that arrives without one (a suite fixture
 * given as a bare body): each `+` becomes `x` and a trailing `#` is dropped.
 */
export function sampleTopic(filter: string): string {
  const levels = filter.split('/').map((l) => (l === '+' ? 'x' : l));
  if (levels[levels.length - 1] === '#') levels.pop();
  return levels.length ? levels.join('/') : 'x';
}
