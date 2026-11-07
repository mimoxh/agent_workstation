export interface Row<T> {
  item: T;
  folded: T[];
}

// 结论把它之前的闲聊收起来：长期项目的会话才不会被消息淹没（PRD 附录 A）；最后一张结论之后的消息留在原位
export function foldByDecision<T>(items: T[], isChat: (t: T) => boolean, isDecision: (t: T) => boolean): Row<T>[] {
  const lastDecision = items.map(isDecision).lastIndexOf(true);
  const rows: Row<T>[] = [];
  let pending: T[] = [];
  items.forEach((item, i) => {
    if (isChat(item) && i < lastDecision) {
      pending.push(item);
    } else if (isDecision(item)) {
      rows.push({ item, folded: pending });
      pending = [];
    } else {
      rows.push({ item, folded: [] });
    }
  });
  return rows;
}
