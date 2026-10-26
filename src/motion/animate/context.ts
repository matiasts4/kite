import { createContext, useContext } from 'react';
import type { LabTokens } from './tokens';

export const LabMotionContext = createContext<LabTokens | null>(null);
export const LabReduceContext = createContext(false);

export function useLabMotion(): LabTokens {
  const tokens = useContext(LabMotionContext);
  if (!tokens) throw new Error('useLabMotion must be used inside AnimateLab');
  return tokens;
}

export function useLabReduce(): boolean {
  return useContext(LabReduceContext);
}
