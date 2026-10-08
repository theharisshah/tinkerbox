import { describe, expect, it } from 'vitest'
import { compactSql, formatSql, tokenizeSql } from '@/components/output/lib/sql'

describe('tokenizeSql', () => {
  it('classifies tokens and keeps the text intact', () => {
    const sql = "select `a`, \"b\" from t where x = 'it''s' and y = ? -- note\nlimit 10"
    const tokens = tokenizeSql(sql)
    expect(tokens.map((t) => t.text).join('')).toBe(sql)
    const significant = tokens.filter((t) => t.type !== 'whitespace')
    expect(significant.map((t) => t.type)).toEqual([
      'keyword',
      'quoted',
      'punct',
      'quoted',
      'keyword',
      'word',
      'keyword',
      'word',
      'operator',
      'string',
      'keyword',
      'word',
      'operator',
      'placeholder',
      'comment',
      'keyword',
      'number'
    ])
  })

  it('handles backslash escapes and unterminated strings', () => {
    expect(tokenizeSql("'a\\'b' c").map((t) => t.type)).toEqual(['string', 'whitespace', 'word'])
    expect(tokenizeSql("'open").map((t) => t.type)).toEqual(['string'])
  })
})

describe('formatSql', () => {
  it('puts uppercase clause keywords on their own lines', () => {
    expect(formatSql("select * from `users` where `id` > 5 and `name` like 'a%' order by `name` asc limit 3")).toBe(
      ['SELECT', '  *', 'FROM', '  `users`', 'WHERE', '  `id` > 5', "  AND `name` LIKE 'a%'", 'ORDER BY', '  `name` ASC', 'LIMIT', '  3'].join('\n')
    )
  })

  it('breaks select columns, keeps function calls and IN lists inline', () => {
    expect(formatSql('select `id`, count(*) as `total`, `name` from `posts` where `id` in (1, 2, 3) group by `id`, `name`')).toBe(
      [
        'SELECT',
        '  `id`,',
        '  count(*) AS `total`,',
        '  `name`',
        'FROM',
        '  `posts`',
        'WHERE',
        '  `id` IN (1, 2, 3)',
        'GROUP BY',
        '  `id`,',
        '  `name`'
      ].join('\n')
    )
  })

  it('indents sub-queries and joins', () => {
    expect(
      formatSql(
        'select * from `users` inner join `posts` on `posts`.`user_id` = `users`.`id` where exists (select 1 from `roles` where `roles`.`id` = `users`.`role_id`)'
      )
    ).toBe(
      [
        'SELECT',
        '  *',
        'FROM',
        '  `users`',
        '  INNER JOIN `posts` ON `posts`.`user_id` = `users`.`id`',
        'WHERE',
        '  EXISTS (',
        '    SELECT',
        '      1',
        '    FROM',
        '      `roles`',
        '    WHERE',
        '      `roles`.`id` = `users`.`role_id`',
        '  )'
      ].join('\n')
    )
  })

  it('keeps BETWEEN … AND together', () => {
    expect(formatSql('select * from t where a between 1 and 5 or b is null')).toBe(
      ['SELECT', '  *', 'FROM', '  t', 'WHERE', '  a BETWEEN 1 AND 5', '  OR b IS NULL'].join('\n')
    )
  })

  it('formats inserts and updates', () => {
    expect(formatSql('insert into `users` (`name`, `email`) values (?, ?), (?, ?)')).toBe(
      ['INSERT INTO', '  `users` (`name`, `email`)', 'VALUES', '  (?, ?),', '  (?, ?)'].join('\n')
    )
    expect(formatSql("update `users` set `name` = 'x', `updated_at` = '2024-01-01' where `id` = 1")).toBe(
      ['UPDATE', '  `users`', 'SET', "  `name` = 'x',", "  `updated_at` = '2024-01-01'", 'WHERE', '  `id` = 1'].join('\n')
    )
  })

  it('keeps the space between a table name and its column list, but not in function calls', () => {
    const out = formatSql('create table fruits (id integer primary key, name text)')
    expect(out).toContain('fruits (id integer')
    expect(formatSql(out)).toBe(out)
    expect(formatSql('select count(*) from t')).toContain('count(*)')
  })

  it('never changes string literals or quoted identifiers', () => {
    const out = formatSql("select 'select from where' as `from` from t")
    expect(out).toContain("'select from where' AS `from`")
  })

  it('is idempotent', () => {
    const once = formatSql('select a, b from t where x = 1 and y = 2 order by a desc')
    expect(formatSql(once)).toBe(once)
  })

  it('compacts whitespace for one-line display', () => {
    expect(compactSql('select *\n  from   t')).toBe('select * from t')
  })
})
