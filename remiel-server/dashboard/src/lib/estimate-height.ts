import { prepare, layout } from '@chenglou/pretext';

/**
 * MessageRow 높이를 DOM 리플로 없이 사전 예측한다.
 *
 * 레이아웃 상수 (MessageTimeline.tsx MessageRow 기반):
 * - outer: px-4(16×2) + py-2.5(10×2) = 좌우 32px, 상하 20px
 * - avatar: w-6(24px) + gap-2.5(10px) = 34px
 * - 콘텐츠 가용 너비: containerWidth - 66
 * - 헤더(사용자명+시간): text-sm font-medium (14px, lh 20px) → 20px
 * - 본문: text-sm (14px, lh 20px), line-clamp-2 → 최대 2줄 = 40px, mt-0.5(2px)
 * - 리액션: text-[11px] (11px), mt-1(4px), 뱃지당 ~50px 너비 → 줄당 ~20px
 * - 하단 border: 1px
 */
export function estimateMessageHeight(
  content: string,
  reactionCount: number,
  containerWidth: number,
): number {
  const contentWidth = Math.max(containerWidth - 66, 100);
  // 상하 패딩(20px) + 헤더(20px) + 하단 border(1px)
  let height = 20 + 20 + 1;

  // 본문 높이 (line-clamp-2: 최대 2줄)
  const prepared = prepare(content.slice(0, 200), '14px -apple-system, sans-serif');
  const { height: textH } = layout(prepared, contentWidth, 20);
  height += Math.min(textH + 2, 42); // mt-0.5(2px) + line-clamp-2(최대 40px)

  // 리액션 행 (뱃지당 ~50px 너비, 가용 너비 기준 행당 개수 계산)
  if (reactionCount > 0) {
    const badgesPerRow = Math.max(Math.floor(contentWidth / 50), 1);
    const reactionRows = Math.ceil(reactionCount / badgesPerRow);
    height += 4 + reactionRows * 20; // mt-1(4px) + 줄당 20px
  }

  return height;
}

/** 날짜 구분선 높이: py-1.5(6+6) + text(16px) = 28px */
export function estimateDateHeight(): number {
  return 28;
}
