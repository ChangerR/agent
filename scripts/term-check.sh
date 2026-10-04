#!/bin/bash
# 终端能力自检：在出问题的终端里直接运行 bash scripts/term-check.sh
echo "== 尺寸通报 =="
echo "stty size: $(stty size)  (行 列)"
echo "COLUMNS=$COLUMNS LINES=$LINES"
echo "TERM=$TERM  TERM_PROGRAM=$TERM_PROGRAM  WT_SESSION=$WT_SESSION"

echo
echo "== 宽度尺：下面这条线的右端应该恰好顶到窗口右缘，且不断行 =="
python3 -c "
import shutil
cols = shutil.get_terminal_size().columns
print('终端认为宽度 =', cols)
print('X' * (cols - 1) + '|')"

echo
echo "== 光标上移测试：1 秒后 BBB/CCC 应被原地替换为 XXX/YYY =="
printf 'AAA\nBBB\nCCC\n'
sleep 1
printf '\x1b[2A\r\x1b[2KXXX\x1b[1B\r\x1b[2KYYY\n'
echo "(如果你看到 BBB/CCC 还留在上面，说明终端不执行光标上移)"

echo
echo "== 清屏归位测试：1 秒后全屏清空，只剩底部一行字 =="
sleep 1
printf '\x1b[2J\x1b[H'
echo "清屏成功：如果你还能看到这里之外的残留文字，说明清屏序列也没执行"
