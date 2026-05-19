#!/usr/bin/env node
/**
 * One-shot helper: render the actual `object.prompt` for each test case in
 * result.md by feeding the v4 snapshot through `fillRuntimeInput`, then
 * splice the rendered prompt back into the markdown file in-place.
 *
 * Run:  npx tsx scripts/fill-result-prompts.ts
 *
 * Replaces the "### 2. 提示词输出 (object.prompt) — 运行时输入段" block of
 * each case with the full rendered prompt wrapped in a 6-backtick fence (so
 * inner ```json blocks render verbatim).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { matchResumeActionObject } from "../generated/v4/match-resume.action-object";
import { fillRuntimeInput } from "../lib/ontology-gen/v4/fill-runtime-input";
import type {
  MatchResumeRuntimeInput,
  RuntimeScope,
} from "../lib/ontology-gen/v4/runtime-input.types";

interface Case {
  id: string;
  input: MatchResumeRuntimeInput;
  scope: RuntimeScope;
}

const TX_JR_DEFAULT = {
  job_requisition_id: "JR-2026-001",
  title: "高级后端工程师",
  client: "腾讯",
  department: "互动娱乐事业群",
  required_skills: ["Java", "Spring Boot", "MySQL"],
  preferred_skills: ["Kafka", "Redis"],
  min_years_experience: 5,
  education: "本科及以上",
  age_max: 40,
  language_requirement: null,
  gender_requirement: null,
};

const BY_JR_DEFAULT = {
  job_requisition_id: "JR-2026-BY-001",
  title: "广告平台高级后端工程师",
  client: "字节",
  department: null,
  required_skills: ["Java", "Spring Boot", "MySQL"],
  preferred_skills: ["Kafka", "Redis", "广告系统经验"],
  min_years_experience: 5,
  education: "本科及以上",
  age_max: null,
  language_requirement: null,
  gender_requirement: null,
};

const TX_SCOPE: RuntimeScope = { client: "腾讯", department: "互动娱乐事业群" };
const BY_SCOPE: RuntimeScope = { client: "字节" };

const cases: Case[] = [
  {
    id: "TX-01",
    scope: TX_SCOPE,
    input: {
      job: TX_JR_DEFAULT,
      resume: {
        candidate_id: "C-TX-01-PASS",
        name: "Alice",
        date_of_birth: "1990-03-15",
        gender: "女",
        highest_education: {
          school: "复旦大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2012,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "字节跳动",
            title: "后端工程师",
            start_date: "2022-01",
            end_date: "2025-12",
            responsibilities: "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。",
          },
          {
            company: "华为",
            title: "软件工程师",
            start_date: "2014-07",
            end_date: "2021-12",
            responsibilities: "终端业务后端开发与维护。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
        language_certifications: [],
        conflict_of_interest_declaration: "无亲属在腾讯任职。",
        expect_salary: "10000",
      },
    },
  },
  {
    id: "TX-02",
    scope: TX_SCOPE,
    input: {
      job: TX_JR_DEFAULT,
      resume: {
        candidate_id: "C-TX-02-NOSALARY",
        name: "Alice",
        date_of_birth: "1990-03-15",
        gender: "女",
        highest_education: {
          school: "复旦大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2012,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "字节跳动",
            title: "后端工程师",
            start_date: "2022-01",
            end_date: "2025-12",
            responsibilities: "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。",
          },
          {
            company: "华为",
            title: "软件工程师",
            start_date: "2014-07",
            end_date: "2021-12",
            responsibilities: "终端业务后端开发与维护。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
        language_certifications: [],
        conflict_of_interest_declaration: "无亲属在腾讯任职。",
      },
    },
  },
  {
    id: "TX-03",
    scope: TX_SCOPE,
    input: {
      job: TX_JR_DEFAULT,
      resume: {
        candidate_id: "C-TX-03-YCH",
        name: "Alice",
        date_of_birth: "1990-03-15",
        gender: "女",
        highest_education: {
          school: "复旦大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2012,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "中软国际",
            title: "后端工程师",
            start_date: "2022-01",
            end_date: "2025-12",
            responsibilities: "负责外包项目后端开发与维护。",
            departure_reason_code: "A15劳动纠纷及诉讼（YCH）",
          },
          {
            company: "华为",
            title: "软件工程师",
            start_date: "2014-07",
            end_date: "2021-12",
            responsibilities: "终端业务后端开发与维护。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
        language_certifications: [],
        conflict_of_interest_declaration: "无亲属在腾讯任职。",
        expect_salary: "10000",
      },
    },
  },
  {
    id: "TX-04",
    scope: TX_SCOPE,
    input: {
      job: TX_JR_DEFAULT,
      resume: {
        candidate_id: "C-TX-04-HUAWEI",
        name: "Tina",
        date_of_birth: "1992-08-10",
        gender: "女",
        highest_education: {
          school: "上海交通大学",
          degree: "本科",
          major: "软件工程",
          graduation_year: 2014,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "华为",
            title: "高级后端工程师",
            start_date: "2020-01",
            end_date: "2026-04",
            responsibilities: "负责分布式交易系统后端开发。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
        language_certifications: [],
        conflict_of_interest_declaration: "无亲属在腾讯任职。",
        expect_salary: "30000",
      },
    },
  },
  {
    id: "TX-05",
    scope: TX_SCOPE,
    input: {
      job: TX_JR_DEFAULT,
      resume: {
        candidate_id: "C-TX-05-SKILLMISS",
        name: "Ian",
        date_of_birth: "1992-05-12",
        gender: "男",
        highest_education: {
          school: "华中科技大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2014,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "美团",
            title: "后端工程师",
            start_date: "2015-07",
            end_date: "2026-04",
            responsibilities: "主要使用 Go 和 PostgreSQL 进行服务端开发。",
          },
        ],
        skill_tags: ["Go", "PostgreSQL", "Kubernetes"],
        language_certifications: [],
        conflict_of_interest_declaration: "无亲属在腾讯任职。",
        expect_salary: "28000",
      },
    },
  },
  {
    id: "TX-06",
    scope: TX_SCOPE,
    input: {
      job: TX_JR_DEFAULT,
      resume: {
        candidate_id: "C-TX-06-AGE",
        name: "Henry",
        date_of_birth: "1980-01-10",
        gender: "男",
        highest_education: {
          school: "浙江大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2002,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "百度",
            title: "后端专家",
            start_date: "2005-07",
            end_date: "2026-04",
            responsibilities: "负责搜索业务后端架构。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
        language_certifications: [],
        conflict_of_interest_declaration: "无亲属在腾讯任职。",
        expect_salary: "35000",
      },
    },
  },
  {
    id: "TX-07",
    scope: TX_SCOPE,
    input: {
      job: TX_JR_DEFAULT,
      resume: {
        candidate_id: "C-TX-07-RELATIVE",
        name: "Nora",
        date_of_birth: "1993-01-23",
        gender: "女",
        highest_education: {
          school: "厦门大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2015,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "快手",
            title: "后端工程师",
            start_date: "2015-07",
            end_date: "2026-04",
            responsibilities: "负责内容分发系统服务端开发。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis"],
        language_certifications: [],
        conflict_of_interest_declaration: "配偶为腾讯正式员工，任职于互动娱乐事业群。",
        expect_salary: "29000",
      },
    },
  },
  {
    id: "TX-08",
    scope: TX_SCOPE,
    input: {
      job: TX_JR_DEFAULT,
      resume: {
        candidate_id: "C-TX-08-REGULAR",
        name: "Owen",
        date_of_birth: "1990-07-07",
        gender: "男",
        highest_education: {
          school: "哈尔滨工业大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2012,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "腾讯",
            employment_type: "正式员工",
            department: "互动娱乐事业群",
            title: "高级后端工程师",
            start_date: "2017-03",
            end_date: "2025-09",
            departure_type: "主动离场",
            responsibilities: "负责游戏账号和交易平台后端开发。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
        language_certifications: [],
        conflict_of_interest_declaration: "无亲属在腾讯任职。",
        expect_salary: "33000",
      },
    },
  },
  {
    id: "TX-09",
    scope: { client: "腾讯", department: "CDG事业群" },
    input: {
      job: {
        job_requisition_id: "JR-2026-TX-CDG-001",
        title: "CDG后端工程师",
        client: "腾讯",
        department: "CDG事业群",
        required_skills: ["Java", "Spring Boot", "MySQL"],
        preferred_skills: ["Redis"],
        min_years_experience: 5,
        education: "本科及以上",
        age_max: 40,
        language_requirement: null,
        gender_requirement: null,
      },
      resume: {
        candidate_id: "C-TX-09-CDG",
        name: "Rita",
        date_of_birth: "1991-05-19",
        gender: "女",
        highest_education: {
          school: "吉林大学",
          degree: "本科",
          major: "软件工程",
          graduation_year: 2013,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "腾讯外包",
            client: "腾讯",
            department: "CDG事业群",
            title: "后端工程师",
            start_date: "2021-01",
            end_date: "2026-01",
            responsibilities: "负责商业化广告系统开发。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis"],
        language_certifications: [],
        conflict_of_interest_declaration: "无亲属在腾讯任职。",
        expect_salary: "29000",
      },
    },
  },
  {
    id: "TX-10",
    scope: TX_SCOPE,
    input: {
      job: {
        job_requisition_id: "JR-2026-TX-Q-001",
        title: "游戏后端工程师",
        client: "腾讯",
        department: "互动娱乐事业群",
        studio: "光子",
        required_skills: ["Java", "Spring Boot", "MySQL"],
        preferred_skills: ["Redis", "Kafka"],
        min_years_experience: 5,
        education: "本科及以上",
        age_max: 40,
        language_requirement: null,
        gender_requirement: null,
      },
      resume: {
        candidate_id: "C-TX-10-STUDIO",
        name: "Quinn",
        date_of_birth: "1992-02-16",
        gender: "男",
        highest_education: {
          school: "华南理工大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2014,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "腾讯",
            department: "互动娱乐事业群",
            studio: "天美",
            title: "后端工程师",
            start_date: "2020-01",
            end_date: "2026-02",
            responsibilities: "负责游戏服务端开发。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis"],
        language_certifications: [],
        conflict_of_interest_declaration: "无亲属在腾讯任职。",
        expect_salary: "30000",
      },
    },
  },
  {
    id: "BY-01",
    scope: BY_SCOPE,
    input: {
      job: BY_JR_DEFAULT,
      resume: {
        candidate_id: "C-BY-01-PASS",
        name: "Ada",
        date_of_birth: "1992-03-20",
        gender: "女",
        marital_status: "已婚已育",
        highest_education: {
          school: "复旦大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2014,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "美团",
            title: "后端工程师",
            start_date: "2015-07",
            end_date: "2026-04",
            responsibilities: "负责广告投放系统服务端开发，使用 Java、Spring Boot、MySQL、Kafka。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka", "广告系统经验"],
        language_certifications: [],
        expect_salary: "30000",
        job_expectation: { outsourcing_acceptance: "接受" },
      },
    },
  },
  {
    id: "BY-02",
    scope: BY_SCOPE,
    input: {
      job: BY_JR_DEFAULT,
      resume: {
        candidate_id: "C-BY-02-MARRIAGE",
        name: "Bella",
        date_of_birth: "1994-01-10",
        gender: "女",
        marital_status: "未婚",
        highest_education: {
          school: "浙江大学",
          degree: "本科",
          major: "软件工程",
          graduation_year: 2016,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "快手",
            title: "后端工程师",
            start_date: "2016-07",
            end_date: "2026-04",
            responsibilities: "负责广告检索和投放平台后端开发。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka", "广告系统经验"],
        matched_bonus_items: ["Kafka", "Redis", "广告系统经验"],
        total_bonus_items: ["Kafka", "Redis", "广告系统经验", "大流量系统经验"],
        language_certifications: [],
        expect_salary: "31000",
        job_expectation: { outsourcing_acceptance: "接受" },
      },
    },
  },
  {
    id: "BY-03",
    scope: BY_SCOPE,
    input: {
      job: BY_JR_DEFAULT,
      resume: {
        candidate_id: "C-BY-03-RECENT",
        name: "Carter",
        date_of_birth: "1991-08-08",
        gender: "男",
        highest_education: {
          school: "上海交通大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2013,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "字节跳动",
            employment_type: "正式员工",
            title: "高级后端工程师",
            start_date: "2018-01",
            end_date: "2026-03",
            departure_type: "主动离职",
            non_compete_status: "已解除",
            responsibilities: "负责广告平台计费链路后端服务。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Kafka", "Redis", "广告系统经验"],
        language_certifications: [],
        expect_salary: "33000",
      },
    },
  },
  {
    id: "BY-04",
    scope: BY_SCOPE,
    input: {
      job: BY_JR_DEFAULT,
      resume: {
        candidate_id: "C-BY-04-HUAWEI",
        name: "Daisy",
        date_of_birth: "1991-09-09",
        gender: "女",
        marital_status: "已婚已育",
        highest_education: {
          school: "南京大学",
          degree: "本科",
          major: "软件工程",
          graduation_year: 2013,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "华为",
            title: "高级后端工程师",
            start_date: "2018-01",
            end_date: "2026-04",
            responsibilities: "负责广告平台后端开发。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka", "广告系统经验"],
        language_certifications: [],
        expect_salary: "31000",
      },
    },
  },
  {
    id: "BY-05",
    scope: BY_SCOPE,
    input: {
      job: BY_JR_DEFAULT,
      resume: {
        candidate_id: "C-BY-05-XIAOMI",
        name: "Eric",
        date_of_birth: "1991-06-20",
        gender: "男",
        highest_education: {
          school: "南京大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2013,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "小米",
            title: "后端架构师",
            start_date: "2021-03",
            end_date: "2026-02",
            responsibilities: "负责广告投放平台后端架构。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Kafka", "广告系统经验"],
        language_certifications: [],
        expect_salary: "32000",
      },
    },
  },
  {
    id: "BY-06",
    scope: BY_SCOPE,
    input: {
      job: BY_JR_DEFAULT,
      resume: {
        candidate_id: "C-BY-06-OVER35",
        name: "Gavin",
        date_of_birth: "1987-04-04",
        gender: "男",
        highest_education: {
          school: "西安交通大学",
          degree: "本科",
          major: "计算机科学与技术",
          graduation_year: 2009,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "京东",
            title: "后端专家",
            start_date: "2010-07",
            end_date: "2026-04",
            responsibilities: "负责广告投放和计费系统架构。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka", "广告系统经验"],
        language_certifications: [],
        expect_salary: "36000",
      },
    },
  },
  {
    id: "BY-07",
    scope: BY_SCOPE,
    input: {
      job: {
        job_requisition_id: "JR-2026-BY-I18N-001",
        title: "国际化广告平台后端工程师",
        client: "字节",
        department: null,
        required_skills: ["Java", "Spring Boot", "MySQL"],
        preferred_skills: ["Kafka", "Redis"],
        min_years_experience: 5,
        education: "本科及以上",
        age_max: null,
        job_tags: ["国际化", "海外"],
        language_requirement: { type: "英语", certificate: "TOEFL", min_score: 100 },
        gender_requirement: null,
      },
      resume: {
        candidate_id: "C-BY-07-NOLANG",
        name: "Helen",
        date_of_birth: "1993-07-07",
        gender: "女",
        marital_status: "已婚已育",
        highest_education: {
          school: "南开大学",
          degree: "本科",
          major: "软件工程",
          graduation_year: 2015,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "Shopee",
            title: "后端工程师",
            start_date: "2016-01",
            end_date: "2026-04",
            responsibilities: "负责国际化广告平台开发。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Kafka"],
        language_certifications: [],
        expect_salary: "30000",
      },
    },
  },
  {
    id: "BY-08",
    scope: BY_SCOPE,
    input: {
      job: {
        job_requisition_id: "JR-2026-BY-NEG-001",
        title: "广告平台高级后端工程师",
        client: "字节",
        department: null,
        required_skills: ["Java", "Spring Boot", "MySQL"],
        preferred_skills: ["Kafka", "Redis"],
        min_years_experience: 5,
        education: "本科及以上",
        age_max: null,
        negative_requirements: [
          { type: "hard_exclusion", description: "最近一段核心经历为纯测试外包经历" },
        ],
        language_requirement: null,
        gender_requirement: null,
      },
      resume: {
        candidate_id: "C-BY-08-NEG",
        name: "Ivy",
        date_of_birth: "1992-12-12",
        gender: "女",
        marital_status: "已婚已育",
        highest_education: {
          school: "湖南大学",
          degree: "本科",
          major: "软件工程",
          graduation_year: 2014,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "某测试外包公司",
            title: "测试开发工程师",
            start_date: "2018-01",
            end_date: "2026-04",
            responsibilities:
              "最近一段核心经历为纯测试外包项目，主要负责测试脚本与自动化测试平台。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL"],
        language_certifications: [],
        expect_salary: "26000",
      },
    },
  },
  {
    id: "BY-09",
    scope: BY_SCOPE,
    input: {
      job: BY_JR_DEFAULT,
      resume: {
        candidate_id: "C-BY-09-EDU",
        name: "Jack",
        date_of_birth: "1990-10-10",
        gender: "男",
        highest_education: {
          school: "某职业高中",
          degree: "高中",
          major: "计算机应用",
          graduation_year: 2008,
          is_full_time: true,
        },
        project_filing_status: "未报备",
        work_experience: [
          {
            company: "创业公司A",
            title: "后端工程师",
            start_date: "2009-07",
            end_date: "2026-04",
            responsibilities:
              "长期负责广告系统后端研发，具备 Java、Spring Boot、MySQL 经验。",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
        language_certifications: [],
        expect_salary: "25000",
      },
    },
  },
  {
    id: "BY-10",
    scope: BY_SCOPE,
    input: {
      job: BY_JR_DEFAULT,
      resume: {
        candidate_id: "C-BY-10-GAP",
        name: "Kevin",
        date_of_birth: "1994-09-09",
        gender: "男",
        highest_education: {
          school: "重庆邮电大学",
          degree: "本科",
          major: "软件工程",
          graduation_year: 2016,
          is_full_time: true,
        },
        work_experience: [
          {
            company: "公司A",
            title: "后端工程师",
            start_date: "2016-07",
            end_date: "2017-03",
            responsibilities: "后端开发。",
          },
          {
            company: "公司B",
            title: "后端工程师",
            start_date: "2018-08",
            end_date: "2019-02",
            responsibilities: "后端开发。",
          },
          {
            company: "公司C",
            title: "后端工程师",
            start_date: "2020-01",
            end_date: "2020-08",
            responsibilities: "后端开发。",
          },
        ],
        career_gaps: [
          {
            start_date: "2017-04",
            end_date: "2018-07",
            duration_months: 16,
            reason: "长时间找不到工作",
          },
        ],
        skill_tags: ["Java", "Spring Boot", "MySQL"],
        language_certifications: [],
        expect_salary: "23000",
      },
    },
  },
];

const FENCE = "``````"; // 6 backticks → won't be closed by inner ```json

const RESULT_PATH = resolve(process.cwd(), "result.md");
let md = readFileSync(RESULT_PATH, "utf8");

let replaced = 0;
for (const c of cases) {
  const filled = fillRuntimeInput(matchResumeActionObject, c.input, c.scope);
  const prompt = filled.prompt;

  const caseHeader = `## 用例 ${c.id}`;
  const caseStart = md.indexOf(caseHeader);
  if (caseStart === -1) {
    process.stderr.write(`[skip] ${c.id}: case header not found\n`);
    continue;
  }
  // case ends at next "## 用例" or next "# §" boundary
  const nextCase = md.indexOf("## 用例 ", caseStart + caseHeader.length);
  const nextSection = md.indexOf("\n# §", caseStart);
  const endCandidates = [nextCase, nextSection].filter((n) => n > caseStart);
  const caseEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : md.length;

  const sliceBefore = md.slice(0, caseStart);
  const slice = md.slice(caseStart, caseEnd);
  const sliceAfter = md.slice(caseEnd);

  const sec2Idx = slice.indexOf("### 2. 提示词输出");
  const sec3Idx = slice.indexOf("### 3. 实际运行结果");
  if (sec2Idx === -1 || sec3Idx === -1) {
    process.stderr.write(`[skip] ${c.id}: section 2/3 markers not found\n`);
    continue;
  }

  const newSec2 =
    "### 2. 提示词输出 (object.prompt)\n\n" +
    FENCE +
    "\n" +
    prompt +
    "\n" +
    FENCE +
    "\n\n";

  const newSlice = slice.slice(0, sec2Idx) + newSec2 + slice.slice(sec3Idx);
  md = sliceBefore + newSlice + sliceAfter;
  replaced++;
}

writeFileSync(RESULT_PATH, md, "utf8");
process.stderr.write(`[fill-result-prompts] replaced ${replaced}/${cases.length} cases → ${RESULT_PATH}\n`);
