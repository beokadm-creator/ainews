// src/types/index.ts

export type ArticleCategory = 
  | 'M&A 동향'
  | 'PEF 동향'
  | 'VC 투자'
  | '펀드 레이징'
  | '엑시트/IPO'
  | '규제/정책'
  | '인물/기타';

export type ArticleStatus = 'pending' | 'filtered' | 'analyzed' | 'rejected' | 'published';
export type SourceType = 'rss' | 'scraping' | 'puppeteer' | 'manual';

export interface CompanyInfo {
  acquiror: string | null;
  target: string | null;
  financialSponsor: string | null;
}

export interface DealInfo {
  type: 'M&A' | '투자' | '펀드레이징' | '엑시트' | '기타';
  amount: string;
  stake: string | null;
}

export interface Article {
  id: string;
  title: string;
  url: string;
  source: string; // 매체명 (예: 네이버뉴스, 더벨)
  sourceId: string; // NewsSource reference
  publishedAt: Date;
  collectedAt: Date;
  
  // Raw Data
  content?: string; // 원문 (또는 요약)
  
  // AI Analysis Results
  summary?: string[]; // 3줄 요약
  category?: ArticleCategory;
  companies?: CompanyInfo;
  deal?: DealInfo;
  insights?: string; // 이음PE 관점 시사점
  tags?: string[];
  
  status: ArticleStatus;
  relevanceScore?: number; // 1단계 필터링 점수 (옵션)
  
  // 회사/파이프라인 참조
  companyId?: string | null;
  pipelineRunId?: string | null;
  globalSourceId?: string | null;
  
  // 북마크 및 관리 데이터
  isBookmarked?: boolean;
  publishedInBriefingId?: string; // 레거시
  publishedInOutputId?: string | null; // 현재 사용
  
  // 관리자 수정 로그
  editedBy?: string;
  editedAt?: Date;
}

export type BriefingStatus = 'draft' | 'pending_review' | 'published' | 'sent';

export interface DailyBriefing {
  id: string; // YYYY-MM-DD 형식 권장
  date: Date;
  
  // 브리핑 메타데이터
  articleIds: string[]; // 포함된 Article ID 배열
  totalArticles: number;
  
  // 종합 분석 (AI 3단계 결과)
  highlights: {
    title: string;
    description: string;
    articleId: string;
  }[]; // Top 3
  
  sectorTrends: {
    category: ArticleCategory;
    description: string;
  }[];
  
  overallInsights: string; // 이음PE 종합 인사이트
  tomorrowOutlook: string; // 내일 주목할 이슈
  
  status: BriefingStatus;
  
  // 발송 기록
  sentAt?: Date;
  sentBy?: string; // Admin User ID
  emailSuccessCount?: number;
  emailFailCount?: number;
  telegramSent?: boolean;
}

export interface NewsSource {
  id: string;
  name: string;
  url: string;
  type: SourceType;
  active: boolean;
  
  // 스크래핑 설정
  selector?: string; // Cheerio CSS 선택자 (레거시, 개별 선택자 권장)
  authType?: 'none' | 'session' | 'cookie' | 'puppeteer';
  keywords?: string[]; // 키워드 필터링 (빈 배열이면 모든 기사 수집)
  
  // 개별 CSS 선택자 (동적 스크래핑용)
  listSelector?: string;    // 리스트 컨테이너 CSS 선택자
  titleSelector?: string;   // 제목 CSS 선택자
  linkSelector?: string;    // 링크 CSS 선택자 (선택사항, 없으면 titleSelector의 href 사용)
  contentSelector?: string; // 본문/요약 CSS 선택자
  dateSelector?: string;    // 날짜 CSS 선택자
  
  lastScrapedAt?: Date;
  lastStatus?: 'success' | 'error';
  errorMessage?: string;
  
  note?: string; // 관리자 메모
}

export interface Subscriber {
  id: string;
  email: string;
  name?: string;
  company?: string;
  telegramChatId?: string;
  active: boolean;
  createdAt: Date;
  tags?: string[]; // 구독자 분류용 태그
}

export interface SystemSettings {
  id: 'global';
  
  // 스케줄링 설정
  scrapingIntervalMinutes: number;
  briefingGenerationTime: string; // HH:mm
  autoSendTime?: string; // 자동 발송 시간 (옵션, 기본은 수동 발송)
  timezone: string;
  activeDays: number[]; // [1,2,3,4,5] (Mon-Fri)
  
  // AI 설정
  glmModel: string;
  promptVersion: string;
  
  // 알림 설정
  adminEmails: string[];
  adminTelegramIds: string[];
  notifyOnScrapingError: boolean;
  
  updatedAt: Date;
  updatedBy: string;
}

export interface User {
  uid: string;
  email: string;
  displayName?: string;
  role: 'superadmin' | 'company_admin' | 'company_editor' | 'viewer';
  companyId?: string;
  companyIds?: string[];
  managedCompanyIds?: string[];
  createdAt: Date;
  lastLoginAt?: Date;
}
