export interface WindowPosition {
  x: number
  y: number
}

export interface WindowSize {
  width: number
  height: number
}

export type WorkArea = WindowPosition & WindowSize

export function parseWindowPosition(value: unknown): WindowPosition | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const position = value as Partial<WindowPosition>
  if (
    typeof position.x !== 'number' ||
    typeof position.y !== 'number' ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    return null
  }

  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
  }
}

export function fitWindowPositionToWorkArea(
  position: WindowPosition,
  size: WindowSize,
  workArea: WorkArea,
): WindowPosition {
  const maxX = workArea.x + Math.max(0, workArea.width - size.width)
  const maxY = workArea.y + Math.max(0, workArea.height - size.height)

  return {
    x: Math.min(Math.max(position.x, workArea.x), maxX),
    y: Math.min(Math.max(position.y, workArea.y), maxY),
  }
}

export type WindowBounds = WindowPosition & WindowSize

/**
 * 窗口改尺寸（收起/展开/内容变化）时保持锚点并夹在工作区内：
 * 顶边不动；窗口在屏幕右半边时右边缘不动（向左展开），否则左边缘不动。
 */
export function anchoredResize(bounds: WindowBounds, size: WindowSize, workArea: WorkArea): WindowBounds {
  const width = Math.max(1, Math.min(Math.round(size.width), workArea.width))
  const height = Math.max(1, Math.min(Math.round(size.height), workArea.height))
  const centerX = bounds.x + bounds.width / 2
  const anchorRight = centerX > workArea.x + workArea.width / 2
  const x = anchorRight ? bounds.x + bounds.width - width : bounds.x
  const position = fitWindowPositionToWorkArea({ x, y: bounds.y }, { width, height }, workArea)
  return { ...position, width, height }
}
