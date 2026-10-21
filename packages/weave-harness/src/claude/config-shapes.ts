import type { ConfigFieldSpec } from '../driver.js';

/**
 * 值形状的补充表：文档只在散文里写「each with …」的数组元素、以及少数 map 的值，
 * 生成器抽不出来（10 个键的写法各不相同）。词表仍是生成物——这里只补结构。
 */
export interface ConfigShapeOverride {
  shape?: 'map' | 'array';
  fields?: readonly ConfigFieldSpec[];
  valueType?: string;
  valueOptions?: readonly string[];
}

const MODE_DENY_MASK: ConfigFieldSpec = { name: 'mode', type: 'enum', options: ['deny', 'mask'] };

export const CONFIG_SHAPE_OVERRIDES: Record<string, ConfigShapeOverride> = {
  'modelPicker.options': {
    shape: 'array',
    fields: [
      { name: 'model', type: 'string', description: 'Anything --model accepts: alias, model ID, or provider ID' },
      { name: 'label', type: 'string', description: 'Row title in the picker' },
      { name: 'description', type: 'string', description: 'Second line under the title' },
      { name: 'behavesAs', type: 'string', description: 'Known model ID whose capabilities this row borrows' },
    ],
  },
  'sandbox.credentials.files': {
    shape: 'array',
    fields: [{ name: 'path', type: 'string' }, MODE_DENY_MASK],
  },
  'sandbox.credentials.envVars': {
    shape: 'array',
    fields: [{ name: 'name', type: 'string' }, MODE_DENY_MASK],
  },
  'sandbox.credentials.awsPairs': {
    shape: 'array',
    fields: [
      { name: 'accessKeyIdVar', type: 'string' },
      { name: 'secretAccessKeyVar', type: 'string' },
      { name: 'sessionTokenVar', type: 'string' },
    ],
  },
  footerLinksRegexes: {
    shape: 'array',
    fields: [
      { name: 'type', type: 'enum', options: ['regex'] },
      { name: 'pattern', type: 'string' },
      { name: 'url', type: 'string' },
    ],
  },
  allowedMcpServers: { shape: 'array', fields: [{ name: 'serverName', type: 'string' }] },
  deniedMcpServers: { shape: 'array', fields: [{ name: 'serverName', type: 'string' }] },
  sshConfigs: {
    shape: 'array',
    fields: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'sshHost', type: 'string' },
      { name: 'sshPort', type: 'number' },
      { name: 'sshIdentityFile', type: 'string' },
    ],
  },
  'modelPricing.overrides': {
    shape: 'map',
    fields: [
      { name: 'input', type: 'number' },
      { name: 'output', type: 'number' },
      { name: 'cacheRead', type: 'number' },
      { name: 'cacheWrite', type: 'number' },
    ],
  },
};
