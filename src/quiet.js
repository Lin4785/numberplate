/**
 * 静音 node:sqlite 的 "实验性 API" 警告，保持控制台干净。
 * 只过滤 SQLite 相关的 ExperimentalWarning，其他警告照常输出。
 */
const originalEmit = process.emit;

process.emit = function emit(name, data, ...args) {
  const isSqliteExperimentalWarning =
    name === 'warning' &&
    data &&
    data.name === 'ExperimentalWarning' &&
    typeof data.message === 'string' &&
    data.message.includes('SQLite');

  if (isSqliteExperimentalWarning) return false;
  return originalEmit.call(this, name, data, ...args);
};
