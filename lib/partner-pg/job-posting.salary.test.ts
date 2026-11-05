import { describe, it, expect, vi } from 'vitest';

// 只测纯解析函数 — mock ./client 避免加载 pg / agent-logger 的模块副作用。
vi.mock('./client', () => ({ withTx: vi.fn() }));

import {
  parseSalaryToken,
  parseSalaryRange,
  saneSalary,
  stripSalaryShell,
  SALARY_SANE_MAX,
  SALARY_SANE_MIN,
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

  // ── 2026-08-25 单位脏数据回归（依据 raas audit-job-posting-salary-units.ts 的真实语料）──

  it('① 共享单位继承：只有右端写单位时，左端裸数继承它（库里 458 行栽在这）', () => {
    expect(parseSalaryRange('6-10K')).toEqual({ min: 6000, max: 10000 });
    expect(parseSalaryRange('6-10k')).toEqual({ min: 6000, max: 10000 });
    expect(parseSalaryRange('18-18.5k')).toEqual({ min: 18000, max: 18500 });
    expect(parseSalaryRange('8~10K')).toEqual({ min: 8000, max: 10000 });
    expect(parseSalaryRange('1.5-2万')).toEqual({ min: 15000, max: 20000 });
  });

  it('① magnitude guard：裸数已是绝对金额（≥1000）时不继承单位', () => {
    // 没有这条，"8000-12k" 会变成 8,000,000-12,000（库里确有该行）
    expect(parseSalaryRange('8000-12k')).toEqual({ min: 8000, max: 12000 });
  });

  it('② 形态闸：剥壳后非纯区间表达 → { null, null }，不再从散文里抠数字', () => {
    // 旧实现分别解析出 70 / 3 / 1，全部写进了月薪列
    expect(parseSalaryRange('社保*70%+公积金据实：12k+200全勤')).toEqual({
      min: null,
      max: null,
    });
    expect(parseSalaryRange('中3: 8400')).toEqual({ min: null, max: null });
    expect(parseSalaryRange('二线测试初-1，薪资4700+200全勤')).toEqual({
      min: null,
      max: null,
    });
    expect(parseSalaryRange('单价上限660')).toEqual({ min: null, max: null });
  });

  it('② 剥壳：标签前缀 / 括号补充 / 周期与 N 薪后缀不影响解析', () => {
    // "薪资范围: " 前缀是 Gohire 回显 create-jd prompt 那一行，库里 131 条
    expect(parseSalaryRange('薪资范围: 10-11k')).toEqual({ min: 10000, max: 11000 });
    expect(parseSalaryRange('12.8k/13.1k(3~8年)')).toEqual({ min: 12800, max: 13100 });
    expect(parseSalaryRange('30-50k * 14薪')).toEqual({ min: 30000, max: 50000 });
    expect(parseSalaryRange('9.7k以内')).toEqual({ min: 9700, max: null });
    expect(parseSalaryRange('8000-12000元/月')).toEqual({ min: 8000, max: 12000 });
  });

  it('③ 裸区间不推断单位：原样返回，交给 saneSalary 丢弃（不在写入侧猜千元）', () => {
    // "单价上限660" 这类日单价录入真实存在，×1000 会造出 66 万/月
    expect(parseSalaryRange('7-12')).toEqual({ min: 7, max: 12 });
    expect(saneSalary(parseSalaryRange('7-12').min)).toBeNull();
  });
});

describe('stripSalaryShell', () => {
  it('只剥壳，不改区间本体', () => {
    expect(stripSalaryShell('薪资范围: 7-11')).toBe('7-11');
    expect(stripSalaryShell('12.8k/13.1k(3~8年)')).toBe('12.8k/13.1k');
    expect(stripSalaryShell('8000-12000元/月')).toBe('8000-12000');
    expect(stripSalaryShell('9.7k以内')).toBe('9.7k');
  });
  it('NFKC 归一全角数字与单位', () => {
    expect(stripSalaryShell('６-１０Ｋ')).toBe('6-10K');
  });
});

describe('saneSalary', () => {
  it('合理月薪原样通过', () => {
    expect(saneSalary(8200)).toBe(8200);
    expect(saneSalary(SALARY_SANE_MIN)).toBe(SALARY_SANE_MIN);
    expect(saneSalary(SALARY_SANE_MAX)).toBe(SALARY_SANE_MAX);
  });
  it('拦截 <1000 的「单位没归一」脏值（2026-08-25 新增下限）', () => {
    // 旧行为 saneSalary(0) === 0、saneSalary(6) === 6，把 6 千写成 6 元
    expect(saneSalary(0)).toBeNull();
    expect(saneSalary(6)).toBeNull();
    expect(saneSalary(SALARY_SANE_MIN - 1)).toBeNull();
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
