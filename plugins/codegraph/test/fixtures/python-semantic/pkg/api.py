from . import base as module


class Child(module.Base):
    @property
    def label(self) -> str:
        return self.run()

def exported() -> str:
    return Child().label
