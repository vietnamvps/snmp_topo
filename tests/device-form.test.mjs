import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const form = readFileSync(new URL('../frontend/src/device-settings.tsx', import.meta.url), 'utf8');

test('SNMP form orders v3 fields, uses new-device defaults and omits untouched secrets', () => {
  const snmp = form.slice(form.indexOf('<h2>SNMP</h2>'), form.indexOf('</fieldset>'));
  const ordered = ["t('version')", "t('udpPort')", "t('username')",
    "secretInput('auth_key')", "t('authAlgorithm')", "secretInput('priv_key')", "t('privacyAlgorithm')", "t('snmpAlgorithmHint')"];
  let previous = -1;
  for (const field of ordered) {
    const index = snmp.indexOf(field);
    assert.ok(index > previous, field + ' must follow the preceding SNMP field');
    previous = index;
  }
  assert.match(snmp, /className="config-field-wide">\{t\('username'\)\}/);
  assert.equal([...snmp.matchAll(/snmpAlgorithmHint/g)].length, 1);
  assert.doesNotMatch(snmp, /community_env|auth_env|privacy_env/);
  const draft = form.slice(form.indexOf('function newDevice'), form.indexOf('function SecretInput'));
  assert.match(draft, /auth_protocol: 'sha', privacy_protocol: 'aes'/);
  assert.match(form, /community_env, auth_env, privacy_env, \.\.\.fields \} = device/);
  assert.match(form, /onChange\(event\.target\.value \|\| undefined\)/);
  assert.match(form, /JSON\.stringify\(\{ \.\.\.\(exists \? fields : \{ id, \.\.\.fields \}\), \.\.\.secretDraft \}\)/);
});
