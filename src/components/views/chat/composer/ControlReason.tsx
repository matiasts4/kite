import React from 'react';

export const ControlReason: React.FC<{ reason: string }> = ({ reason }) => (
  <span className="sr-only">{reason}</span>
);
