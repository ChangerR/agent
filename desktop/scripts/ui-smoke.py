"""真实离线 React 界面冒烟。先运行 desktop:build、desktop:preview；仅访问本机 FakeProvider。"""
import json
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin = os.environ.get('AGENTLAB_UI_ORIGIN', 'http://127.0.0.1:4175')
if not origin.startswith('http://127.0.0.1:'):
    raise ValueError('UI 冒烟只允许本机隔离预览')
out = Path(os.environ.get('AGENTLAB_UI_EVIDENCE', '/tmp/agentlab-ui-evidence'))
out.mkdir(parents=True, exist_ok=True)
model_id = 'cloud-ui-' + uuid.uuid4().hex[:8]
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 960}, device_scale_factor=2)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(origin)
    page.get_by_role('button', name='离线演示', exact=True).click()
    expect(page.get_by_label('输入任务')).to_be_enabled()
    page.get_by_role('button', name='打开应用设置').click()
    page.get_by_role('button', name='主任务与模型连接（启动默认值）', exact=True).click()
    model_override = page.get_by_role('checkbox', name='覆盖 模型 ID', exact=True)
    expect(model_override).to_be_visible()
    model_override.check()
    page.get_by_role('textbox', name='模型 ID', exact=True).fill(model_id)
    expect(page.get_by_text('未保存', exact=True)).to_be_visible()
    page.once('dialog', lambda dialog: dialog.dismiss())
    page.get_by_role('button', name='所有项目', exact=False).click()
    expect(page.get_by_label('应用设置', exact=True)).to_be_visible()
    page.get_by_role('button', name='提交此节', exact=True).click()
    expect(page.get_by_text('已保存', exact=True)).to_be_visible()
    expect(page.get_by_role('textbox', name='模型 ID', exact=True)).to_have_value(model_id)
    page.get_by_role('checkbox', name='覆盖 Endpoint URL', exact=True).check()
    page.get_by_role('textbox', name='Endpoint URL', exact=True).fill('file:///invalid-endpoint')
    page.get_by_role('button', name='提交此节', exact=True).click()
    expect(page.get_by_role('alert').filter(has_text='验证或保存失败')).to_be_visible()
    page.get_by_role('button', name='放弃更改', exact=True).click()
    expect(page.get_by_role('checkbox', name='覆盖 Endpoint URL', exact=True)).not_to_be_checked()
    page.get_by_role('combobox', name='配置作用域', exact=True).select_option('global')
    expect(model_override).not_to_be_checked()
    page.get_by_role('combobox', name='配置作用域', exact=True).select_option('project')
    expect(model_override).to_be_checked()
    page.screenshot(path=str(out / 'settings-light.png'), full_page=True)
    page.get_by_role('combobox', name='设置界面主题', exact=True).select_option('dark')
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    page.get_by_role('button', name='上下文与缓存预算', exact=True).click()
    expect(page.get_by_role('checkbox', name='覆盖 最大轮数', exact=True)).to_be_visible()
    page.get_by_role('checkbox', name='覆盖 最大轮数', exact=True).check()
    page.get_by_role('spinbutton', name='最大轮数', exact=True).fill('12')
    page.get_by_role('button', name='清除此节的本层覆盖', exact=True).click()
    expect(page.get_by_role('checkbox', name='覆盖 最大轮数', exact=True)).not_to_be_checked()
    expect(page.get_by_text('未保存', exact=True)).to_be_visible()
    page.get_by_role('button', name='放弃更改', exact=True).click()
    page.get_by_role('combobox', name='设置界面主题', exact=True).select_option('system')
    page.emulate_media(color_scheme='dark')
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    page.set_viewport_size({'width': 900, 'height': 650})
    # 仅模拟 renderer 的 macOS 安全区；不能证明 AppKit/原生交通灯或菜单通过。
    page.evaluate("document.documentElement.dataset.platform = 'darwin'")
    page.screenshot(path=str(out / 'mac-layout-simulation-dark.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '窗口发生横向溢出'
    assert not errors, errors
    print(json.dumps({'result': 'passed', 'checks': ['React 设置保存', '未保存导航拦截', '校验失败反馈', '用户/项目隔离', '安全重置草稿', '系统暗色', '900px 高DPI 布局'], 'native_macos': False, 'screenshots': [str(path) for path in out.glob('*.png')]}, ensure_ascii=False))
    browser.close()
