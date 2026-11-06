import { describe, it, expect, vi } from 'vitest';

// 只测纯解析函数 — mock ./client 避免加载 pg / agent-logger 的模块副作用。
vi.mock('./client', () => ({ withTx: vi.fn() }));

import {
  parseSalaryToken,
  parseSalaryRange,
  saneSalary,
  SALARY_SANE_MAX,
} from './job-posting';

describe('parseSalaryToken', () => {
  it('k/K 后缀 + 小数 → ×1000', () => {
    expect(parseSalaryToken('8.2k')).toBe(8200);
    expect(parseSalaryToken('8.5K')).toBe(8500);
    expect(parseSalaryToken('8k')).toBe(8000);
  });
  it('万 / w 后缀 → ×10000', () => {
    expect(parseSalaryToken('1.5万')).toBe(15000);
    expect(parseSalaryToken('2w')).toBe(20000);
    expect(parseSalaryToken('3W')).toBe(30000);
  });
  it('千 后缀 → ×1000', () => {
    expect(parseSalaryToken('8千')).toBe(8000);
  });
  it('纯数字 + 千分位逗号', () => {
    expect(parseSalaryToken('8000')).toBe(8000);
    expect(parseSalaryToken('12,000')).toBe(12000);
    expect(parseSalaryToken('12，000')).toBe(12000);
  });
  it('非数字 / 空 → null', () => {
    expect(parseSalaryToken('面议')).toBeNull();
    expect(parseSalaryToken('')).toBeNull();
    expect(parseSalaryToken(null)).toBeNull();
    expect(parseSalaryToken(undefined)).toBeNull();
  });
});

describe('parseSalaryRange', () => {
  it('回归: "8.2k/8.5k" 必须 → 8200/8500 (旧实现错算成 8200085000 导致 int4 溢出)', () => {
    expect(parseSalaryRange('8.2k/8.5k')).toEqual({ min: 8200, max: 8500 });
  });
  it('支持 - ~ ～ 到 至 ／ 多种分隔符', () => {
    expect(parseSalaryRange('8000-12000')).toEqual({ min: 8000, max: 12000 });
    expect(parseSalaryRange('1.5万~2万')).toEqual({ min: 15000, max: 20000 });
    expect(parseSalaryRange('1.5万～2万')).toEqual({ min: 15000, max: 20000 });
    expect(parseSalaryRange('8000到12000')).toEqual({ min: 8000, max: 12000 });
    expect(parseSalaryRange('10k至15k')).toEqual({ min: 10000, max: 15000 });
    expect(parseSalaryRange('8k／12k')).toEqual({ min: 8000, max: 12000 });
  });
  it('单值 → max 为 null', () => {
    expect(parseSalaryRange('8k')).toEqual({ min: 8000, max: null });
    expect(parseSalaryRange('8000')).toEqual({ min: 8000, max: null });
  });
  it('null / 空 / 非数字 → { null, null }', () => {
    expect(parseSalaryRange(null)).toEqual({ min: null, max: null });
    expect(parseSalaryRange(undefined)).toEqual({ min: null, max: null });
    expect(parseSalaryRange('面议')).toEqual({ min: null, max: null });
  });
});

describe('saneSalary', () => {
  it('合理月薪原样通过', () => {
    expect(saneSalary(8200)).toBe(8200);
    expect(saneSalary(0)).toBe(0);
    expect(saneSalary(SALARY_SANE_MAX)).toBe(SALARY_SANE_MAX);
  });
  it('拦截 8200085000 脏值 (int4 溢出守卫)', () => {
    expect(saneSalary(8200085000)).toBeNull();
    expect(saneSalary(SALARY_SANE_MAX + 1)).toBeNull();
  });
  it('负数 / 非有限 / null → null', () => {
    expect(saneSalary(-1)).toBeNull();
    expect(saneSalary(NaN)).toBeNull();
    expect(saneSalary(Infinity)).toBeNull();
    expect(saneSalary(null)).toBeNull();
  });
});
