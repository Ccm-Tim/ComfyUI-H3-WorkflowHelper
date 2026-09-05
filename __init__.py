# -*- coding: utf-8 -*-
"""ComfyUI-H3-WorkflowHelper

H3 工作流辅助插件：前端按钮（插入参考图/音频/图+音频、延长视频、删除最后一段、整理排版）。
全部按钮产出的都是 ComfyUI 内核官方节点；删除本插件后，工作流仍是 100% 官方节点链。
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
