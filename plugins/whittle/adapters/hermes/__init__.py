from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POLICY = ROOT / 'skills' / 'whittle' / 'SKILL.md'


def instructions():
    try:
        text = POLICY.read_text(encoding='utf-8').replace('\r\n', '\n')
    except OSError:
        return ''
    header = '## Clean-code policy\n'
    start = text.find(header)
    if start < 0:
        return ''
    start += len(header)
    end = text.find('\n## ', start)
    return text[start:end if end >= 0 else None].strip()


def pre_llm_call(**_):
    policy = instructions()
    return {'context': policy} if policy else None


def register(context):
    context.register_skill('whittle', POLICY)
    context.register_hook('pre_llm_call', pre_llm_call)
